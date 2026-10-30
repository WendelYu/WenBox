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
   window.state={clipboard:{enabled:false,active:false,message:'文本同步已关闭',limitBytes:1048576},keyboardMap:{ctrl:'super',super_key:'ctrl',alt:'alt',shift:'shift'},platform:'Windows',installed:true,backendRunning:false,serviceReady:true,profileReady:false,role:'source',tlsConfigured:true,systemInput:true,message:'流转已关闭',events:[],managed:{enabled:false,side:'right',peer:null,pending:null,error:null,local:{id:'local',name:'本机',platform:'Windows',enabled:false,pairing:false,role:'source',side:'right'}}};
   window.WenBox={async copyText(text){window.copied=text;}};
   window.__TAURI__={async invoke(command,args){window.calls.push({command,args});const s=window.state,m=s.managed;
    if(command==='kvm_status'){if(window.failStatus)throw new Error('fixture failed');const value=structuredClone(s);if(window.statusDelay)await new Promise(r=>setTimeout(r,window.statusDelay));return value;}
    if(command==='kvm_start'){m.enabled=true;s.message='等待配对';}
    if(command==='kvm_stop'){m.enabled=false;s.backendRunning=false;s.message='流转已关闭';}
    if(command==='kvm_pairing_window'){m.enabled=true;m.local.pairing=true;}
    if(command==='kvm_discover')return[{info:{id:'off',name:'未开启设备',enabled:false,role:'target',pairing:false},ip:'192.168.1.9'},{info:{id:'peer',name:'<img src=x onerror=alert(1)>',platform:'macOS',enabled:true,pairing:true,role:'target',side:'left'},ip:'192.168.1.2'}];
    if(command==='kvm_pair'){m.pending={session:'fixture-session',name:'<img src=x onerror=alert(1)>',code:'12345678',expiresIn:120,localConfirmed:false,remoteConfirmed:false};}
    if(command==='kvm_confirm'){if(args.accept){m.peer={id:'peer',name:'测试 Mac',ip:'192.168.1.2',fingerprint:'a'.repeat(64)};s.profileReady=true;s.backendRunning=true;}m.pending=null;}
    if(command==='kvm_forget'){m.peer=null;m.pending=null;s.profileReady=false;s.backendRunning=false;}
    if(command==='kvm_clipboard'){s.clipboard.enabled=args.enabled;s.clipboard.message=args.enabled?'等待两端开启并连接':'文本同步已关闭';}
    if(command==='kvm_release'){m.enabled=false;s.backendRunning=false;}
    if(command==='kvm_keyboard_map'){s.keyboardMap=args.mapping;}
    if(command==='kvm_layout'){m.side=args.side;}
    if(command==='kvm_pointer_speed'){s.pointerSpeed=args.percent;}
    if(command==='kvm_scroll_speed'){s.scrollSpeed=args.percent;}
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
  assert.equal(await page.locator('#kvmCandidates li').count(),1);
  await page.locator('#kvmCandidates button').click();await page.locator('#kvmPending').waitFor({state:'visible'});
  assert.equal(await page.locator('#kvmPairCode').innerText(),'1234 5678');assert.equal(await page.locator('#kvmLayoutCard').isHidden(),true);
  await page.locator('[data-kvm="diagnostics"]').click();await page.waitForFunction(()=>!!window.copied);assert.equal((await page.evaluate(()=>window.copied)).includes('12345678'),false);
  await page.locator('[data-kvm="reject"]').click();await page.locator('#kvmPending').waitFor({state:'hidden'});
  await page.locator('[data-kvm="pair"]').click();await page.locator('#kvmPending').waitFor({state:'visible'});
  await page.locator('[data-kvm="confirm"]').click();await page.locator('#kvmLayoutCard').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-kvm="pairing"]').isDisabled(),true);
  await page.locator('[data-kvm-side="top"]').click();await page.waitForFunction(()=>document.querySelector('#kvmPeerScreen').dataset.side==='top');
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='kvm_layout'&&c.args.side==='top')),true);
  await page.evaluate(()=>{window.state.pointerSpeed=100;});await page.locator('[data-kvm="refresh"]').click();
  await page.evaluate(()=>{window.statusDelay=150;});
  await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.locator('[data-kvm-speed="150"]').isDisabled(),false);
  await page.locator('[data-kvm-speed="150"]').click();await page.waitForFunction(()=>window.state.pointerSpeed===150);
  await page.evaluate(()=>{window.statusDelay=0;});
  await page.evaluate(()=>{window.state.events=[{time:1,message:'已开启流转'}]});await page.locator('[data-kvm="refresh"]').click();
  await page.evaluate(()=>{window.savedEventNode=document.querySelector('#kvmEvents li');});
  await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.evaluate(()=>window.savedEventNode===document.querySelector('#kvmEvents li')),true);
  await page.evaluate(()=>{window.state.inputConnected=true;});await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.locator('#kvmStatusBadge').innerText(),'已连接');
  await page.evaluate(()=>{window.state.inputConnected=false;});await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.locator('#kvmStatusBadge').innerText(),'等待连接');
  assert.equal(await page.locator('#kvmClipboardSettings').isVisible(),true);
  await page.locator('[data-kvm="clipboard"]').click();
  await page.waitForFunction(()=>window.state.clipboard.enabled);
  assert.equal(await page.locator('[data-kvm="clipboard"]').innerText(),'关闭文本同步');
  await page.locator('[data-kvm="clipboard"]').click();
  await page.waitForFunction(()=>!window.state.clipboard.enabled);
  await page.locator('#kvmKeyboardPreset').selectOption('custom');
  await page.locator('[data-keymap="alt"]').selectOption('shift');
  await page.locator('[data-keymap="shift"]').selectOption('alt');
  await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.locator('[data-keymap="alt"]').inputValue(),'shift','polling preserves draft');
  await page.locator('[data-kvm="keymap"]').click();
  await page.waitForFunction(()=>window.state.keyboardMap.alt==='shift');
  await page.locator('#kvmKeyboardPreset').selectOption('original');await page.locator('[data-kvm="keymap"]').click();
  await page.waitForFunction(()=>window.state.keyboardMap.ctrl==='ctrl');
  await page.evaluate(()=>{window.state.role='target';window.state.managed.local.role='target';window.state.scrollSpeed=100;});
  await page.locator('[data-kvm="refresh"]').click();await page.locator('#kvmScrollSettings').waitFor({state:'visible'});
  await page.locator('#kvmScrollSpeed').fill('150');await page.locator('[data-kvm="scroll-speed"]').click();
  await page.waitForFunction(()=>window.state.scrollSpeed===150);
  assert.equal(await page.locator('[data-kvm-side="left"]').isDisabled(),true);
  await page.evaluate(()=>{window.state.role='source';window.state.managed.local.role='source';});await page.locator('[data-kvm="refresh"]').click();
  await page.locator('[data-kvm="release"]').click();await page.waitForFunction(()=>!document.querySelector('[data-kvm="start"]').disabled);
  assert.equal(await page.locator('#kvmLayoutCard').isHidden(),true);
  assert.equal(await page.locator('#kvmPairingCard').isHidden(),true);
  await page.locator('[data-kvm="start"]').click();await page.locator('#kvmLayoutCard').waitFor({state:'visible'});
  await page.locator('[data-kvm="forget"]').click();await page.locator('#kvmLayoutCard').waitFor({state:'hidden'});
  assert.equal(await page.locator('#kvmPermissions').isHidden(),true);
  await page.evaluate(()=>{window.state.platform='macOS';window.state.permissions={accessibility:true,inputMonitoring:false};});
  await page.locator('[data-kvm="refresh"]').click();await page.locator('#kvmDetails > summary').click();await page.locator('#kvmPermissions').waitFor({state:'visible'});
  assert.equal(await page.locator('#kvmAccessibilityStatus').innerText(),'已授权');
  assert.equal(await page.locator('#kvmInputStatus').innerText(),'需要授权或重新授权');
  assert.match(await page.locator('#kvmSettingsSummary').innerText(),/输入监控/);
  for(const [action,pane] of [['settings','accessibility'],['input-settings','input-monitoring'],['reveal-app','reveal-app']]) {
   await page.locator(`[data-kvm="${action}"]`).click();
   await page.waitForFunction(pane=>window.calls.some(c=>c.command==='kvm_open_settings'&&c.args.pane===pane),pane);
  }
  await page.evaluate(()=>{window.failStatus=true;});await page.locator('[data-kvm="refresh"]').click();await page.locator('#kvmError').waitFor({state:'visible'});assert.equal(await page.locator('[data-kvm="start"]').isDisabled(),true);
  await page.evaluate(()=>{document.querySelector('main').hidden=true;document.dispatchEvent(new CustomEvent('wenbox:viewchange'));});const count=await page.evaluate(()=>window.calls.length);await page.waitForTimeout(3800);assert.equal(await page.evaluate(()=>window.calls.length),count);
  if (process.env.KVM_SCREEN_DIR) {
   fs.mkdirSync(process.env.KVM_SCREEN_DIR,{recursive:true});
   for (const css of ['tokens.css','style.css','workspace.css','kvm.css','polish.css']) await page.addStyleTag({path:'app/src/main/assets/web/'+css});
   await page.evaluate(()=>{window.failStatus=false;document.body.dataset.activeView='view-kvm';document.body.style.display='block';document.body.style.overflow='auto';document.querySelector('main').hidden=false;window.state.platform='macOS';window.state.inputConnected=true;window.state.backendRunning=true;window.state.managed.enabled=true;window.state.managed.local.name='我的 Mac';window.state.managed.side='left';window.state.managed.peer={id:'peer',name:'工作电脑 · Windows',ip:'192.168.1.2'};window.state.permissions={accessibility:true,inputMonitoring:true};document.querySelector('#kvmDetails').open=false;document.dispatchEvent(new CustomEvent('wenbox:viewchange'));});
   for (const [theme,width] of [['light',1280],['dark',1280],['light',390]]) {
    await page.setViewportSize({width,height:1100});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:`${process.env.KVM_SCREEN_DIR}/connected-${theme}-${width}.png`,fullPage:true});
   }
  }
  assert.deepEqual(errors,[]);console.log('PASS M2 UI: native boundary, device discovery, SAS display, cancel/confirm, no early trust UI, diagnostics redaction, layout, enable/stop/revoke, stale state and polling cleanup');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
