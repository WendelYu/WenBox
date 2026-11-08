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
    if(command==='kvm_scroll_speed'){if(window.failScrollSave)throw Error('fixture scroll save failed');s.scrollSpeed=args.percent;}
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
  await page.locator('[data-kvm-speed="150"]').click();
  assert.equal(await page.locator('#kvmPointerValue').innerText(),'1.50×');
  assert.equal(await page.locator('[data-kvm-speed="150"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-kvm="save-mouse"]').click();await page.waitForFunction(()=>window.state.pointerSpeed===150);
  // Both controls are drafted and saved together, without resending unchanged values.
  await page.evaluate(()=>{window.state.scrollSpeed=100;});
  await page.locator('[data-kvm="refresh"]').click();
  await page.waitForFunction(()=>!document.querySelector('#kvmScrollSpeed').disabled);
  await page.locator('#kvmPointerSpeed').fill('125');
  await page.locator('#kvmScrollSpeed').fill('175');
  await page.locator('[data-kvm="refresh"]').click();
  assert.equal(await page.locator('#kvmPointerSpeed').inputValue(),'125');
  assert.equal(await page.locator('#kvmScrollSpeed').inputValue(),'175');
  await page.locator('[data-kvm="save-mouse"]').click();
  await page.waitForFunction(()=>window.state.pointerSpeed===125&&window.state.scrollSpeed===175);
  assert.equal(await page.locator('[data-kvm="save-mouse"]').isDisabled(),true);
  // If the second backend save fails, only its draft remains pending for retry.
  await page.evaluate(()=>{window.failScrollSave=true;});
  await page.locator('#kvmPointerSpeed').fill('150');await page.locator('#kvmScrollSpeed').fill('125');
  await page.locator('[data-kvm="save-mouse"]').click();await page.locator('#kvmError').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.state.pointerSpeed),150);
  assert.equal(await page.locator('#kvmScrollSpeed').inputValue(),'125');
  assert.equal(await page.locator('[data-kvm="save-mouse"]').isDisabled(),false);
  const pointerSaves=await page.evaluate(()=>window.calls.filter(c=>c.command==='kvm_pointer_speed').length);
  await page.evaluate(()=>{window.failScrollSave=false;});await page.locator('[data-kvm="save-mouse"]').click();
  await page.waitForFunction(()=>window.state.scrollSpeed===125);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='kvm_pointer_speed').length),pointerSaves);
  assert.equal(await page.locator('#kvmSide').count(),0,'screen board is the only position control');
  assert.equal(await page.locator('.kvm-hero [data-kvm="clipboard"]').count(),1);
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
  await page.locator('#kvmKeyboardSettings > summary').click();
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
  await page.locator('#kvmScrollSpeed').fill('150');await page.locator('[data-kvm="save-mouse"]').click();
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
   const shell=await browser.newPage();await shell.emulateMedia({reducedMotion:'reduce'});shell.on('pageerror',e=>errors.push(e.message));
   const shellHtml=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace('src="logo.png"','src="data:image/png;base64,'+fs.readFileSync('app/src/main/assets/web/logo.png').toString('base64')+'"');
   await shell.setContent(shellHtml);
   const state=await page.evaluate(()=>{const s=structuredClone(window.state);s.platform='macOS';s.role='source';s.inputConnected=true;s.pointerSpeed=125;s.scrollSpeed=100;s.backendRunning=true;s.managed.enabled=true;s.managed.local.role='source';s.managed.local.name='我的 MacBook';s.managed.side='left';s.managed.peer={id:'peer',name:'工作电脑 · Windows',ip:'192.168.1.2'};s.permissions={accessibility:true,inputMonitoring:true};s.clipboard.enabled=true;s.clipboard.message='文本同步已开启 · 仅同步新复制的文本';return s;});
   await shell.evaluate(state=>{
    window.__TAURI__={invoke:async()=>structuredClone(state)};
    window.WenBox={copyText:async()=>{}};
    document.body.dataset.activeView='view-kvm';document.body.dataset.roomMode='host';
    for(const main of document.querySelectorAll('main.primary-view'))main.hidden=main.id!=='view-kvm';
    for(const nav of document.querySelectorAll('.nav-tab')){const active=nav.dataset.view==='view-kvm';nav.classList.toggle('active',active);nav.setAttribute('aria-pressed',String(active));}
    for(const [id,text] of Object.entries({roomName:'设计工作室',roomRoleBadge:'房主',roomLock:'公开房间',workspaceTitle:'键鼠流转',workspaceSubtitle:'让设备之间的协作更自然',chatMyNicknameDisplay:'我的 MacBook',serviceHealthText:'服务正常',clientVersion:'v1.4.12',chatOnlineMemberBadge:'2 人在线 · 查看成员'}))document.getElementById(id).textContent=text;
    document.getElementById('serviceHealth').dataset.state='ready';
   },state);
   for(const css of ['tokens.css','style.css','workspace.css','kvm.css','polish.css'])await shell.addStyleTag({path:'app/src/main/assets/web/'+css});
   await shell.addScriptTag({path:'app/src/main/assets/web/kvm.js'});
   await shell.evaluate(()=>document.dispatchEvent(new CustomEvent('wenbox:viewchange')));
   await shell.locator('#kvmLayoutCard').waitFor({state:'visible'});
   for(const [theme,width,height] of [['light',1440,1000],['dark',1440,1000],['light',1024,900],['light',768,1000],['light',390,844],['dark',390,844]]){
    await shell.setViewportSize({width,height});await shell.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await shell.waitForTimeout(250);
    assert.equal(await shell.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`KVM overflow at ${width}`);
    const buttons=await shell.locator('.kvm-hero-actions button:visible').all();assert.equal(buttons.length,4);
    const boxes=await Promise.all(buttons.map(b=>b.boundingBox()));
    assert.ok(Math.abs(boxes[0].width-boxes[1].width)<2,'balanced action widths');
    assert.ok(Math.abs(boxes[0].y-boxes[1].y)<2,'first action row aligned');
    assert.ok(Math.abs(boxes[2].y-boxes[3].y)<2,'second action row aligned');
    if(width===1440){const save=await shell.locator('[data-kvm="save-mouse"]').boundingBox();assert.ok(save.y+save.height<height,'mouse settings fit in desktop viewport');}
    await shell.screenshot({path:`${process.env.KVM_SCREEN_DIR}/workspace-${theme}-${width}.png`,fullPage:false});
   }
   await shell.close();
  }
  assert.deepEqual(errors,[]);console.log('PASS UI redesign: combined speed saves and partial retry, direct screen controls, top clipboard, responsive action grid; M2: native boundary, device discovery, SAS display, cancel/confirm, no early trust UI, diagnostics redaction, layout, enable/stop/revoke, stale state and polling cleanup');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
