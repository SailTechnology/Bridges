import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {HttpError, atomicJson, readJson} from './util.mjs';

function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
export class Auth {
  constructor(credentialFile) {
    this.file=credentialFile;fs.mkdirSync(path.dirname(credentialFile),{recursive:true});
    let data=readJson(credentialFile);
    if(!data){data={key:crypto.randomBytes(32).toString('base64url')};atomicJson(credentialFile,data);}
    this.key=data.key;this.pairing=null;this.attempts=new Map();
  }
  sign(s){return crypto.createHmac('sha256',this.key).update(s).digest('base64url');}
  authenticated(req,local) {
    if(local)return true;
    const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if(bearer&&equal(bearer,this.key))return true;
    const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('bridges='))?.slice(8);
    if(!cookie)return false;
    const [nonce,expiry,signature]=cookie.split('.');
    return Number(expiry)>Date.now()&&equal(signature,this.sign(`${nonce}.${expiry}`));
  }
  require(req,local){if(!this.authenticated(req,local))throw new HttpError(401,'请先与 Windows 配对');}
  pair() {
    this.pairing={code:crypto.randomInt(10000000,100000000).toString(),expires:Date.now()+10*60*1000};
    return this.pairing;
  }
  login(req,code) {
    const address=req.socket.remoteAddress||'unknown',now=Date.now();
    // The reverse proxy collapses remote addresses; the shared limit is intentionally conservative.
    for(const [k,v]of this.attempts)if(now-v.start>60000)this.attempts.delete(k);
    const entry=this.attempts.get(address)||{start:now,count:0};entry.count++;this.attempts.set(address,entry);
    if(entry.count>5)throw new HttpError(429,'尝试过多，请一分钟后再试');
    if(!this.pairing||this.pairing.expires<now||!equal(String(code),this.pairing.code))throw new HttpError(403,'配对码无效或已过期');
    this.pairing=null;
    const data=`${crypto.randomBytes(20).toString('base64url')}.${now+7*86400000}`;
    const secure=req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
    return `bridges=${data}.${this.sign(data)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure?'; Secure':''}`;
  }
}
