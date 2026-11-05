# Test-only browser fixture. Run against npm run dev:web with Python Playwright installed.
from playwright.sync_api import sync_playwright, expect
import json
import os
fixture=r'''(() => {
  let changed=()=>{};
  const state={apps:[],settings:{sdkPath:'/private/runtime',scrcpyPath:'/private/runtime/scrcpy',phoneAvd:'Phone',tvAvd:'TV',defaultMode:'phone'},runtime:{sdkFound:true,adbFound:true,emulatorFound:true,aaptFound:true,scrcpyFound:true,avds:['Phone','TV'],devices:[{serial:'emulator-5554',avd:'Phone',state:'device'}],issues:[]}};
  window.fixture={state,calls:[],resolveSend:null,change:()=>changed()};
  window.apkChecker={getState:async()=>structuredClone(state),onProgress:()=>()=>{},onStateChanged:cb=>{changed=cb;return()=>{}},sendText:(mode,text)=>{window.fixture.calls.push({mode,text});return new Promise(resolve=>window.fixture.resolveSend=resolve)}};
})();'''
results=[]; errors=[]
with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=os.environ.get('APK_CHROMIUM_PATH', '/usr/bin/chromium'),args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1040,'height':720})
  page.on('pageerror',lambda error: errors.append(str(error)))
  page.add_init_script(fixture)
  page.goto(os.environ.get('APK_UI_URL', 'http://127.0.0.1:5173'))
  button=page.get_by_role('button',name='输入文字',exact=True)
  button.click()
  dialog=page.get_by_role('dialog',name='向手机模拟器输入文字')
  expect(dialog).to_be_visible()
  field=dialog.get_by_role('textbox',name='要发送的文字')
  expect(field).to_be_focused()
  field.fill('测试123')
  field.dispatch_event('compositionstart',{'data':''})
  field.dispatch_event('keydown',{'key':'Enter','code':'Enter','keyCode':229,'isComposing':True,'bubbles':True})
  assert page.evaluate('window.fixture.calls')==[]
  field.dispatch_event('compositionend',{'data':'测试'})
  field.dispatch_event('keydown',{'key':'Enter','code':'Enter','isComposing':False,'bubbles':True})
  assert page.evaluate('window.fixture.calls')==[]
  results.append('IME composition and trailing Enter do not send text')
  page.wait_for_timeout(150)
  field.press('Enter')
  expect(dialog.get_by_role('button',name='正在发送…')).to_be_disabled()
  expect(dialog.get_by_role('button',name='取消',exact=True)).to_be_disabled()
  field.dispatch_event('keydown',{'key':'Enter','repeat':True,'bubbles':True})
  field.press('Escape')
  expect(dialog).to_be_visible()
  assert page.evaluate('window.fixture.calls')==[{'mode':'phone','text':'测试123'}]
  page.evaluate("window.fixture.resolveSend({ok:false,error:'模拟器窗口已关闭，请重新打开应用。'})")
  expect(dialog.get_by_role('alert')).to_have_text('模拟器窗口已关闭，请重新打开应用。')
  expect(field).to_have_value('测试123')
  results.append('single send; no repeated Enter; busy controls; failure preserves editable text')
  field.press('Enter')
  assert len(page.evaluate('window.fixture.calls'))==2
  page.evaluate('window.fixture.resolveSend({ok:true})')
  expect(dialog).not_to_be_visible()
  expect(button).to_be_focused()
  expect(page.get_by_text('文字已发送，请在模拟器中确认',exact=True)).to_be_visible()
  button.click();expect(field).to_have_value('')
  field.fill('测试123')
  page.screenshot(path=os.environ.get('APK_UI_SCREENSHOT', '/tmp/text-input-ui-1040.png'))
  field.press('Escape');expect(dialog).not_to_be_visible()
  results.append('success wording is sent, not Android accepted; close clears text and restores focus')
  # With two running devices, text input chooses its target at action time.
  page.evaluate("window.fixture.state.runtime.devices.push({serial:'emulator-5556',avd:'TV',state:'device'});window.fixture.change()")
  button.click()
  chooser=page.get_by_role('dialog',name='选择输入文字的设备')
  expect(chooser).to_be_visible()
  chooser.get_by_role('radio',name='电视',exact=True).check()
  chooser.get_by_role('button',name='继续输入',exact=True).click()
  tv=page.get_by_role('dialog',name='向电视模拟器输入文字')
  field=tv.get_by_role('textbox',name='要发送的文字')
  field.fill('line1');field.press('Shift+Enter');field.press('a')
  expect(field).to_have_value('line1\na')
  assert len(page.evaluate('window.fixture.calls'))==2
  # A runtime/default-mode refresh cannot retarget an open text dialog.
  page.evaluate("window.fixture.state.runtime.devices=window.fixture.state.runtime.devices.filter(d=>d.avd==='Phone');window.fixture.state.settings.defaultMode='phone';window.fixture.change()")
  expect(tv).to_be_visible()
  field.press('Enter')
  assert page.evaluate('window.fixture.calls')[-1]=={'mode':'tv','text':'line1\na'}
  page.evaluate('window.fixture.resolveSend({ok:true})')
  expect(tv).not_to_be_visible()
  results.append('Two running devices prompt for target; Shift+Enter keeps newline; open dialog remains TV after runtime refresh')
  button.click()
  field=dialog.get_by_role('textbox',name='要发送的文字')
  field.fill('测'*6000)
  expect(dialog.get_by_role('button',name='发送文字',exact=True)).to_be_disabled()
  expect(dialog.get_by_role('alert')).to_have_text('文字过长，单次最多发送 16 KB。')
  field.press('Escape');button.click();expect(field).to_have_value('')
  field.fill('clear me')
  # Focus stays inside the dialog and returns to the input after last button.
  field.press('Shift+Tab')
  expect(dialog.get_by_role('button',name='发送文字',exact=True)).to_be_focused()
  page.keyboard.press('Tab');expect(field).to_be_focused()
  dialog.get_by_role('button',name='取消',exact=True).click()
  button.click();expect(field).to_have_value('');field.press('Escape')
  results.append('UTF-8 byte cap, cancel clears text, and focus trap verified')
  # If the chosen device goes offline, keep the target invalid until explicitly changed.
  page.evaluate("window.fixture.state.runtime.devices.push({serial:'emulator-5556',avd:'TV',state:'device'});window.fixture.change()")
  button.click()
  expect(chooser.get_by_role('radio',name='手机',exact=True)).to_be_checked()
  page.evaluate("window.fixture.state.runtime.devices=window.fixture.state.runtime.devices.filter(d=>d.avd==='TV');window.fixture.change()")
  expect(chooser.get_by_role('radio',name='手机',exact=True)).to_be_disabled()
  expect(chooser.get_by_role('radio',name='手机',exact=True)).to_be_checked()
  proceed=chooser.get_by_role('button',name='继续输入',exact=True)
  expect(proceed).to_be_disabled()
  cancel=chooser.get_by_role('button',name='取消',exact=True)
  remaining=chooser.get_by_role('radio',name='电视',exact=True)
  cancel.focus();cancel.press('Tab');expect(remaining).to_be_focused()
  expect(proceed).to_be_disabled()
  remaining.press('Shift+Tab');expect(cancel).to_be_focused()
  cancel.press('Shift+Tab');expect(remaining).to_be_focused()
  remaining.press('Space');expect(remaining).to_be_checked();expect(proceed).to_be_enabled()
  proceed.click();expect(tv).to_be_visible()
  tv.get_by_role('textbox',name='要发送的文字').fill('目标确认')
  tv.get_by_role('button',name='发送文字',exact=True).click()
  assert page.evaluate('window.fixture.calls')[-1]=={'mode':'tv','text':'目标确认'}
  page.evaluate('window.fixture.resolveSend({ok:true})');expect(tv).not_to_be_visible()
  results.append('Offline selected device disables Continue; keyboard can reach remaining radio without silent retarget; explicit TV choice sends to TV')
  page.evaluate("window.fixture.state.runtime.devices=[{serial:'emulator-5556',avd:'TV',state:'device'}];window.fixture.change()")
  button.click()
  expect(tv).to_be_visible()
  expect(page.get_by_role('dialog',name='选择输入文字的设备')).not_to_be_visible()
  tv.get_by_role('button',name='取消',exact=True).click()
  results.append('Only-running TV is selected directly without a global mode tab')
  page.evaluate('window.fixture.state.runtime.devices=[];window.fixture.change()')
  button.click()
  expect(page.get_by_role('dialog')).not_to_be_visible()
  expect(page.get_by_text('请先打开一个应用',exact=True)).to_be_visible()
  results.append('closed mode has explicit guidance and never invokes sendText')
  assert not errors, errors
  browser.close()
print(json.dumps({'passed':results,'pageErrors':errors,'scope':'Chromium UI fixture only; no Android/device/host IME implementation claim'},ensure_ascii=False,indent=2))
