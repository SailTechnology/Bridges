import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {HttpError, atomicJson, readJson, digest} from './util.mjs';

function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
const COOKIE_AGE=400*86400; // Browser retention only; device grants have no server expiry.
export class Auth {
  constructor(credentialFile) {
    this.file=credentialFile;fs.mkdirSync(path.dirname(credentialFile),{recursive:true});
    let data=readJson(credentialFile);
    if(fs.existsSync(credentialFile)&&(typeof data?.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.key)))throw new Error('配对凭据文件损坏，已保留原文件');
    if(!data){data={key:crypto.randomBytes(32).toString('base64url')};atomicJson(credentialFile,data);}
    this.key=data.key;this.pairing=null;this.attempts=new Map();
    this.devicesFile=path.join(path.dirname(credentialFile),'trusted-devices.json');
    const registry=readJson(this.devicesFile);
    if(fs.existsSync(this.devicesFile)){
      const devices=registry?.devices;
      if(registry?.version!==1||!devices||typeof devices!=='object'||Array.isArray(devices)||
        Object.entries(devices).some(([deviceId,device])=>!device||device.id!==deviceId||
          !/^[a-f0-9-]{36}$/.test(deviceId)||typeof device.name!=='string'||
          !/^[a-f0-9]{64}$/.test(device.tokenHash)||!Number.isFinite(Date.parse(device.createdAt))||
          !Number.isFinite(Date.parse(device.lastSeenAt))||
          (device.revokedAt!==null&&!Number.isFinite(Date.parse(device.revokedAt)))))
        throw new Error('设备授权文件损坏，已保留原文件');
    }
    this.devices=Object.assign(Object.create(null),registry?.devices||{});
  }
  saveDevices(){atomicJson(this.devicesFile,{version:1,devices:this.devices});}
  sign(s){return crypto.createHmac('sha256',this.key).update(s).digest('base64url');}
  cookieValue(req){return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('bridges='))?.slice(8);}
  deviceClaim(token,via){
    const match=/^dev1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token||'');
    if(!match)return null;
    const device=this.devices[match[1]];
    if(!device||device.revokedAt||!equal(device.tokenHash,digest(token)))return null;
    return {owner:`device:${device.id}`,deviceId:device.id,deviceName:device.name,permanent:true,token,via};
  }
  claim(req,local=false){
    if(local)return {owner:'windows-local',local:true,permanent:false};
    const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if(bearer){
      if(equal(bearer,this.key))return {owner:'api-owner',permanent:false,legacy:true};
      return this.deviceClaim(bearer,'bearer');
    }
    const cookie=this.cookieValue(req),device=this.deviceClaim(cookie,'cookie');
    if(device)return device;
    if(!cookie)return null;
    // Existing signed sessions can be upgraded without another pairing code.
    const parts=cookie.split('.');if(parts.length!==3)return null;
    const [nonce,expiry,signature]=parts;
    if(Number(expiry)>Date.now()&&equal(signature,this.sign(`${nonce}.${expiry}`)))return {owner:`legacy:${nonce}`,legacy:true,permanent:false};
    return null;
  }
  authenticated(req,local){return Boolean(this.claim(req,local));}
  cookie(req,token){
    const secure=req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
    return `bridges=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_AGE}${secure?'; Secure':''}`;
  }
  require(req,local,res){
    const claim=this.claim(req,local);if(!claim)throw new HttpError(401,'设备尚未授权或授权已撤销，请与 Windows 配对');
    if(claim.deviceId){
      const device=this.devices[claim.deviceId],now=Date.now();
      if(now-Date.parse(device.lastSeenAt||0)>3600000){device.lastSeenAt=new Date(now).toISOString();this.saveDevices();}
      if(res&&claim.via==='cookie')res.setHeader('Set-Cookie',this.cookie(req,claim.token));
    }
    return claim;
  }
  pair() {
    this.pairing={code:crypto.randomInt(10000000,100000000).toString(),expires:Date.now()+10*60*1000};
    return this.pairing;
  }
  issueDevice(req,name){
    const deviceId=crypto.randomUUID(),token=`dev1.${deviceId}.${crypto.randomBytes(32).toString('base64url')}`;
    const now=new Date().toISOString();
    this.devices[deviceId]={id:deviceId,name:String(name||'已配对设备').replace(/[\r\n]/g,' ').slice(0,80),tokenHash:digest(token),createdAt:now,lastSeenAt:now,revokedAt:null};
    this.saveDevices();return {deviceId,deviceToken:token,cookie:this.cookie(req,token),permanent:true};
  }
  loginDevice(req,code,name){
    const address=req.socket.remoteAddress||'unknown',now=Date.now();
    for(const [k,v]of this.attempts)if(now-v.start>60000)this.attempts.delete(k);
    const entry=this.attempts.get(address)||{start:now,count:0};entry.count++;this.attempts.set(address,entry);
    if(entry.count>5)throw new HttpError(429,'尝试过多，请一分钟后再试');
    if(!this.pairing||this.pairing.expires<now||!equal(String(code),this.pairing.code))throw new HttpError(403,'配对码无效或已过期');
    this.pairing=null;return this.issueDevice(req,name);
  }
  login(req,code){return this.loginDevice(req,code).cookie;}
  remember(req,name){
    const claim=this.claim(req,false);if(!claim)throw new HttpError(401,'请先完成首次配对');
    if(claim.permanent)return {deviceId:claim.deviceId,deviceToken:claim.token,cookie:this.cookie(req,claim.token),permanent:true};
    return this.issueDevice(req,name||'已配对客户端');
  }
  listDevices(){return Object.values(this.devices).map(({tokenHash,...device})=>({...device,permanent:true}));}
  revoke(deviceId){
    const device=this.devices[deviceId];if(!device)throw new HttpError(404,'设备授权不存在');
    device.revokedAt=new Date().toISOString();this.saveDevices();return {revoked:true,deviceId};
  }
}
