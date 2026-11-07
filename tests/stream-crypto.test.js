const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('fs'),vm=require('vm');
test('lazy encryption slices interoperate, include authenticated EOF, and never read whole files',async()=>{
 const c={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,DataView};c.window=c;vm.createContext(c);
 for(const f of ['aes-gcm.js','stream-crypto.js'])vm.runInContext(fs.readFileSync('app/src/main/assets/web/'+f,'utf8'),c);
 const data=crypto.randomBytes(2*1024*1024+17),key=crypto.randomBytes(32);let largest=0;
 const file={name:'test.bin',size:data.length,slice(a,b){largest=Math.max(largest,b-a);return new Blob([data.subarray(a,b)]);}};
 const source=c.WenBoxStreamCrypto.encryptedFile(file,key,'room');const parts=[];
 for(let i=0;i<source.size;i+=512*1024)parts.push(Buffer.from(await source.slice(i,i+512*1024).arrayBuffer()));
 const wire=Buffer.concat(parts);assert.equal(wire.length,source.size);assert(largest<=1024*1024);
 const base=wire.subarray(5,17),out=[];let index=0,offset=21,final=false;
 while(offset<wire.length){const len=wire.readUInt32BE(offset);offset+=4;const cipher=wire.subarray(offset,offset+len);offset+=len;const nonce=Buffer.from(base);nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4)+BigInt(index),4);
 const d=crypto.createDecipheriv('aes-256-gcm',key,nonce);d.setAAD(Buffer.from(`wenbox-file:v1:room:${index++}`));d.setAuthTag(cipher.subarray(-16));const plain=Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]);if(!plain.length){final=true;break;}out.push(plain);}
 assert(final);assert.equal(offset,wire.length);assert.deepEqual(Buffer.concat(out),data);
});
