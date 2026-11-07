const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const vm=require('node:vm');
const fs=require('node:fs');
function client(){
 const c={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa};c.window=c;vm.createContext(c);
 for(const f of ['aes-gcm.js','key-exchange.js'])vm.runInContext(fs.readFileSync('app/src/main/assets/web/'+f,'utf8'),c);
 return c.WenBoxKeyExchange.begin();
}
function envelope(c,secret){
 const server=crypto.createECDH('prime256v1');server.generateKeys();const pub=server.getPublicKey();
 const shared=server.computeSecret(Buffer.from(c.publicKey,'base64'));
 const key=Buffer.from(crypto.hkdfSync('sha256',shared,Buffer.from('wenbox-key-exchange:v1'),Buffer.concat([Buffer.from(c.publicKey,'base64'),pub]),32));
 const nonce=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('wenbox-key-wrap:v1'));
 const sealed=Buffer.concat([nonce,cipher.update(secret),cipher.final(),cipher.getAuthTag()]);
 return {version:1,publicKey:pub.toString('base64'),ciphertext:'wbx1:'+sealed.toString('base64')};
}
test('browser ephemeral P256/HKDF key wrapping interoperates with platform crypto',()=>{
 const c=client();const secret=crypto.randomBytes(32).toString('base64');const wire={room:{keyEnvelope:envelope(c,secret)}};
 assert(!JSON.stringify(wire).includes(secret));c.open(wire);assert.equal(wire.room.contentKey,secret);
});
test('wrong requester and modified envelopes fail closed',()=>{
 const a=client(),b=client();const env=envelope(a,crypto.randomBytes(32).toString('base64'));
 assert.throws(()=>b.open({keyEnvelope:env}));env.ciphertext=env.ciphertext.slice(0,-5)+'AAAAA';assert.throws(()=>a.open({keyEnvelope:env}));
});
test('browser rejects a legacy plaintext key response',()=>assert.throws(()=>client().open({room:{contentKey:'old-secret'}})));
