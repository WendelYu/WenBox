// M2 native bridge fixture. Never starts an actual input core or network pairing.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('app/src/main/assets/web/index.html', 'utf8');
const panel = /<main id="view-kvm"[\s\S]*?<\/main>/.exec(html)[0];
async function main() {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
 try {
  const errors=[];const plain=await browser.newPage();plain.on('pageerror',e=>errors.push(e.message));
  await plain.setContent(panel);await plain.addScriptTag({path:'app/src/main/assets/web/kvm.js'});
  await plain.evaluate(()=>{document.querySelector('main').hidden=false;document.dispatchEvent(new CustomEvent('wenbox:viewchange'));});
  assert.match(await plain.locator('#kvmMessage').innerText(),/仅支持/);assert.equal(await plain.locator('[data-kvm="pair"]').isDisabled(),true);await plain.close();
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setContent('<meta name="wenbox-version" content="1.4.5">'+panel);
  await page.evaluate(()=>{
   window.calls=[];window.failStatus=false;
   window.state={platform:'Windows',installed:true,backendRunning:false,serviceReady:true,profileReady:false,role:'source',tlsConfigured:true,systemInput:true,message:'流转已关闭',events:[],managed:{enabled:false,side:'right',peer:null,pending:null,error:null,local:{id:'local',name:'本机',platform:'Windows',enabled:false,pairing:false,role:'source',side:'right'}}};
   window.WenBox={async copyText(text){window.copied=text;}};
   window.__TAURI__={async invoke(command,args){window.calls.push({command,args});const s=window.state,m=s.managed;
    if(command==='kvm_status'){if(window.failStatus)throw new Error('fixture failed');return structuredClone(s);}
    if(command==='kvm_start'){m.enabled=true;s.message='等待配对';}
    if(command==='kvm_stop'){m.enabled=false;s.backendRunning=false;s.message='流转已关闭';}
    if(command==='kvm_pairing_window'){m.enabled=true;m.local.pairing=true;}
    if(command==='kvm_discover')return[{info:{id:'peer',name:'<img src=x onerror=alert(1)>',platform:'macOS',pairing:true,role:'target',side:'left'},ip:'192.168.1.2'}];
    if(command==='kvm_pair'){m.pending={session:'fixture-session',name:'<img src=x onerror=alert(1)>',code:'12345678',expiresIn:120,localConfirmed:false,remoteConfirmed:false};}
    if(command==='kvm_confirm'){if(args.accept){m.peer={id:'peer',name:'测试 Mac',ip:'192.168.1.2',fingerprint:'a'.repeat(64)};s.profileReady=true;s.backendRunning=true;}m.pending=null;}
    if(command==='kvm_forget'){m.peer=null;m.pending=null;s.profileReady=false;s.backendRunning=false;}
    if(command==='kvm_layout'){m.side=args.side;}
    if(command==='kvm_role'){m.local.role=args.role;s.role=args.role;}
   }};
  });
  await page.addScriptTag({path:'app/src/main/assets/web/kvm.js'});
  assert.equal(await page.evaluate(()=>window.calls.length),0);
  await page.evaluate(()=>{document.querySelector('main').hidden=false;document.dispatchEvent(new CustomEvent('wenbox:viewchange'));});
  await page.waitForFunction(()=>!document.querySelector('[data-kvm="start"]').disabled);
  await page.locator('[data-kvm="start"]').click();await page.waitForFunction(()=>!document.querySelector('[data-kvm="stop"]').disabled);
  await page.locator('[data-kvm="pairing"]').click();await page.locator('[data-kvm="discover"]').click();
  await page.waitForFunction(()=>document.querySelector('#kvmCandidates button')&&!document.querySelector('#kvmCandidates button').disabled);
  assert.equal(await page.locator('#kvmCandidates img').count(),0);
  await page.locator('#kvmCandidates button').click();await page.locator('#kvmPending').waitFor({state:'visible'});
  assert.equal(await page.locator('#kvmPairCode').innerText(),'1234 5678');assert.equal(await page.locator('#kvmLayoutCard').isHidden(),true);
  await page.locator('[data-kvm="diagnostics"]').click();await page.waitForFunction(()=>!!window.copied);assert.equal((await page.evaluate(()=>window.copied)).includes('12345678'),false);
  await page.locator('[data-kvm="reject"]').click();await page.locator('#kvmPending').waitFor({state:'hidden'});
  await page.locator('[data-kvm="pair"]').click();await page.locator('#kvmPending').waitFor({state:'visible'});
  await page.locator('[data-kvm="confirm"]').click();await page.locator('#kvmLayoutCard').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-kvm="pairing"]').isDisabled(),true);
  await page.selectOption('#kvmSide','top');await page.locator('[data-kvm="layout"]').click();await page.waitForFunction(()=>document.querySelector('#kvmPeerScreen').dataset.side==='top');
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='kvm_layout'&&c.args.side==='top')),true);
  await page.locator('[data-kvm="stop"]').click();await page.waitForFunction(()=>!document.querySelector('[data-kvm="start"]').disabled);
  await page.locator('[data-kvm="forget"]').click();await page.locator('#kvmLayoutCard').waitFor({state:'hidden'});
  await page.evaluate(()=>{window.failStatus=true;});await page.locator('[data-kvm="refresh"]').click();await page.locator('#kvmError').waitFor({state:'visible'});assert.equal(await page.locator('[data-kvm="start"]').isDisabled(),true);
  await page.evaluate(()=>{document.querySelector('main').hidden=true;document.dispatchEvent(new CustomEvent('wenbox:viewchange'));});const count=await page.evaluate(()=>window.calls.length);await page.waitForTimeout(3800);assert.equal(await page.evaluate(()=>window.calls.length),count);
  assert.deepEqual(errors,[]);console.log('PASS M2 UI: native boundary, device discovery, SAS display, cancel/confirm, no early trust UI, diagnostics redaction, layout, enable/stop/revoke, stale state and polling cleanup');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
