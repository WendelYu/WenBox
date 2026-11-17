/* Lazy file encryption: slice reads at most two 1 MiB frames at a time. */
(function(root){
 const CHUNK=1024*1024, HEADER=21;
 function encryptedFile(file,key,room){
  const base=crypto.getRandomValues(new Uint8Array(12));const count=Math.ceil(file.size/CHUNK);
  const size=HEADER+file.size+(count+1)*20;
  const header=new Uint8Array(HEADER);header.set(new TextEncoder().encode('WBXF1'));header.set(base,5);new DataView(header.buffer).setUint32(17,CHUNK);
  const nonce=i=>{const b=base.slice(),v=new DataView(b.buffer);v.setBigUint64(4,v.getBigUint64(4)+BigInt(i));return b;};
  let lastIndex = -1, lastFrame;
  async function frameAt(index) {
   if (index === lastIndex) return lastFrame;
   const start = index * CHUNK;
   const plain = new Uint8Array(await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer());
   const aad = new TextEncoder().encode(`wenbox-file:v1:${room}:${index}`);
   const cipher = root.WenBoxCipher.gcm(key, nonce(index), aad).encrypt(plain);
   const frame = new Uint8Array(4 + cipher.length);
   new DataView(frame.buffer).setUint32(0, cipher.length);
   frame.set(cipher, 4);
   lastIndex = index;
   lastFrame = frame;
   return frame;
  }
  return {name:file.name,type:'application/octet-stream',size,plainSize:file.size,virtualEncrypted:true,
   forTransfer: () => encryptedFile(file, key, room),
   slice(start,end){return {async arrayBuffer(){
    end=Math.min(end,size);start=Math.max(0,start);const out=new Uint8Array(Math.max(0,end-start));
    function copy(bytes,offset){const lo=Math.max(start,offset),hi=Math.min(end,offset+bytes.length);if(hi>lo)out.set(bytes.subarray(lo-offset,hi-offset),lo-start);}
    copy(header,0);
    const first=Math.min(count,Math.max(0,Math.floor((start-HEADER)/(CHUNK+20))));
    for(let i=first;i<=count;i++){
     const offset=i===count ? HEADER+file.size+count*20 : HEADER+i*(CHUNK+20);if(offset>=end)break;
     copy(await frameAt(i), offset);
    }
    return out.buffer;
   }}}};
 }
 root.WenBoxStreamCrypto={encryptedFile};
})(typeof window==='undefined'?globalThis:window);
