import { p256 } from '@noble/curves/p256';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const b64=b=>btoa(String.fromCharCode(...b));
const text=new TextEncoder();
function begin(){
 const privateKey=p256.utils.randomPrivateKey(); const publicKey=p256.getPublicKey(privateKey,false);
 return {publicKey:b64(publicKey),open(value){
  function unwrap(v){
   if(!v || typeof v!=='object')return;
   if(typeof v.contentKey==='string' && v.contentKey)throw Error('对端仍在明文发送密钥，请升级对端');
   if(v.keyExchangeRequired && !v.keyEnvelope)throw Error("缺少安全密钥协商响应，请升级两端");
   if(v.keyEnvelope){
    const env=v.keyEnvelope;if(env.version!==1)throw Error('不支持的密钥协商版本');
    const server=bytes(env.publicKey);const secret=p256.getSharedSecret(privateKey,server,false).slice(1,33);
    const info=new Uint8Array(130);info.set(publicKey);info.set(server,65);
    const key=hkdf(sha256,secret,text.encode('wenbox-key-exchange:v1'),info,32);
    if(!env.ciphertext.startsWith('wbx1:'))throw Error('无效的密钥信封');
    const encrypted=bytes(env.ciphertext.slice(5));
    const plain=globalThis.WenBoxCipher.gcm(key,encrypted.slice(0,12),text.encode('wenbox-key-wrap:v1')).decrypt(encrypted.slice(12));
    const result=new TextDecoder().decode(plain);if(bytes(result).length!==32)throw Error('无效的房间密钥');
    delete v.keyEnvelope;v.contentKey=result;secret.fill(0);key.fill(0);
   }
   for(const [k,child] of Object.entries(v))if(k!=='contentKey')unwrap(child);
  }
  try{unwrap(value);return value;}finally{privateKey.fill(0);}
 }};
}
globalThis.WenBoxKeyExchange={begin};
