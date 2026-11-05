# Test-only browser fixture. Run against npm run dev:web with Python Playwright installed.
from playwright.sync_api import sync_playwright, expect
import json
import os
fixture=r'''(() => {
  let changed=()=>{};
  const state={apps:[],settings:{sdkPath:'/private/runtime',scrcpyPath:'/private/runtime/scrcpy',phoneAvd:'Phone',tvAvd:'TV',defaultMode:'phone'},runtime:{sdkFound:true,adbFound:true,emulatorFound:true,aaptFound:true,scrcpyFound:true,avds:['Phone','TV'],devices:[{serial:'emulator-5554',avd:'Phone',state:'device'},{serial:'emulator-5556',avd:'TV',state:'device'}],issues:[]}};
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
  page.get_by_role('button',name='电视模式',exact=True).click()
  button.click()
  tv=page.get_by_role('dialog',name='向电视模拟器输入文字')
  field=tv.get_by_role('textbox',name='要发送的文字')
  field.fill('line1');field.press('Shift+Enter');field.press('a')
  expect(field).to_have_value('line1\na')
  assert len(page.evaluate('window.fixture.calls'))==2
  # Changing page selection in the background cannot retarget an open dialog.
  page.get_by_role('button',name='手机模式',exact=True).evaluate('(button)=>button.click()')
  expect(tv).to_be_visible()
  field.press('Enter')
  assert page.evaluate('window.fixture.calls')[-1]=={'mode':'tv','text':'line1\na'}
  page.evaluate('window.fixture.resolveSend({ok:true})')
  expect(tv).not_to_be_visible()
  results.append('Shift+Enter keeps newline; dialog target remains TV after background selection changes')
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
  page.evaluate('window.fixture.state.runtime.devices=[];window.fixture.change()')
  expect(page.get_by_text('设备运行中',exact=True)).not_to_be_visible()
  button.click()
  expect(page.get_by_role('dialog')).not_to_be_visible()
  expect(page.get_by_text('请先打开一个手机应用',exact=True)).to_be_visible()
  results.append('closed mode has explicit guidance and never invokes sendText')
  assert not errors, errors
  browser.close()
print(json.dumps({'passed':results,'pageErrors':errors,'scope':'Chromium UI fixture only; no Android/device/host IME implementation claim'},ensure_ascii=False,indent=2))
