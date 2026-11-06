# Test-only browser fixture. No Android installation or device operation is performed.
# Start npm run dev:web, then run with Python Playwright and Chromium installed.
from playwright.sync_api import sync_playwright, expect
import json
import os
import re

fixture = r'''(() => {
  let changed = () => {};
  const app = (id, name, installed = {}) => ({id, name, installed,
    packageName: 'test.' + id, versionName: '1.0', versionCode: '1',
    size: 1024 * 1024, importedAt: '2026-11-05T00:00:00Z', fileName: id + '.apk'});
  const state = {
    apps: [app('maidong', '麦动'),
      app('reader', '读书', {phone: {avd:'Phone', installedAt:'2026-11-05'}, tv: {avd:'OldTV', installedAt:'2026-11-05'}}),
      app('cinema', '影院', {tv: {avd:'TV', installedAt:'2026-11-05'}}), app('spare', '备用')],
    settings: {sdkPath:'/private/runtime', scrcpyPath:'/private/runtime/scrcpy', phoneAvd:'Phone', tvAvd:'TV', defaultMode:'phone'},
    runtime: {sdkFound:true, adbFound:true, emulatorFound:true, aaptFound:true, scrcpyFound:true,
      avds:['Phone','TV'], devices:[], issues:[]},
    managed: {supported:true, coreReady:true, phoneReady:true, tvReady:true,
      licenseAccepted:true, downloadBytes:{phone:1024,tv:2048}}
  };
  const f = window.fixture = {state, calls:[], holdInstall:false, holdPrepare:false,
    nextInstallError:null, change:() => changed()};
  window.apkChecker = {
    getState:async()=>structuredClone(state), onProgress:()=>()=>{},
    onStateChanged:cb=>{changed=cb;return()=>{}},
    installApp:(id,mode)=>{
      f.calls.push({action:'install',id,mode});
      return new Promise(resolve=>{
        f.resolveInstall=result=>{
          if(result.ok) state.apps.find(a=>a.id===id).installed[mode]={avd:mode==='phone'?'Phone':'TV',installedAt:'2026-11-05'};
          f.resolveInstall=null; resolve(result);
        };
        if(!f.holdInstall) {
          const result=f.nextInstallError?{ok:false,error:f.nextInstallError}:{ok:true};
          f.nextInstallError=null; f.resolveInstall(result);
        }
      });
    },
    launchApp:async(id,mode)=>{f.calls.push({action:'launch',id,mode});return {ok:true}},
    uninstallApp:async(id,mode)=>{
      f.calls.push({action:'uninstall',id,mode});
      delete state.apps.find(a=>a.id===id).installed[mode]; return {ok:true};
    },
    prepareEnvironment:(mode,acceptLicense)=>{
      f.calls.push({action:'prepare',mode,acceptLicense});
      return new Promise(resolve=>{
        f.resolvePrepare=result=>{
          if(result.ok) {state.managed.coreReady=true;state.managed[mode==='phone'?'phoneReady':'tvReady']=true;if(acceptLicense)state.managed.licenseAccepted=true;}
          f.resolvePrepare=null; resolve(result);
        };
        if(!f.holdPrepare) f.resolvePrepare({ok:true});
      });
    },
    cancelPreparation:async()=>{f.calls.push({action:'cancel'});f.resolvePrepare?.({ok:false,error:'准备已取消'});return {ok:true}},
    getRuntimeLicense:async()=> 'Android test-only license fixture',
    saveSettings:async(settings)=>{state.settings=structuredClone(settings);return {ok:true}}
  };
})();'''

results = []
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('APK_CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1040,'height':800})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(fixture)
    page.goto(os.environ.get('APK_UI_URL', 'http://127.0.0.1:5173'))
    nav = page.get_by_role('navigation', name='主导航')
    cards = page.locator('.application-card')
    def goto(name):
        nav.get_by_role('button', name=re.compile('^' + name)).click()
    def card(name, mode=None):
        selected = cards.filter(has=page.get_by_role('heading', name=name, exact=True))
        if mode:
            selected = selected.filter(has=page.locator('.mode-tag').filter(has_text=re.compile('^'+mode+'$')))
        return selected
    def calls(action):
        return page.evaluate('(action)=>window.fixture.calls.filter(c=>c.action===action)', action)
    def install(name):
        card(name).get_by_role('button', name=re.compile('^安装')).click()
        dialog = page.get_by_role('dialog', name='安装「'+name+'」')
        expect(dialog).to_be_visible()
        return dialog
    def close_notice():
        if page.get_by_role('button', name='关闭通知').count():
            page.get_by_role('button', name='关闭通知').click()

    expect(cards).to_have_count(2)
    expect(card('读书','手机')).to_have_count(1)
    expect(card('读书','电视')).to_have_count(0)
    expect(card('影院','电视')).to_have_count(1)
    expect(page.get_by_role('button', name='手机模式', exact=True)).to_have_count(0)
    expect(page.get_by_role('button', name='电视模式', exact=True)).to_have_count(0)
    results.append('Unified desktop shows current phone/TV installations; stale AVD record is excluded; no mode tabs')

    goto('软件库')
    expect(cards).to_have_count(4)
    filter_control = page.get_by_role('combobox',name='按安装状态筛选')
    filter_control.select_option('installed');expect(cards).to_have_count(2)
    filter_control.select_option('uninstalled');expect(cards).to_have_count(2)
    filter_control.select_option('all')
    search = page.get_by_role('textbox',name='搜索应用')
    search.fill('test.reader');expect(cards).to_have_count(1)
    search.fill('')
    # A stale TV installation must not disable reinstalling into the current TV AVD.
    dialog=install('读书')
    expect(dialog.get_by_role('radio',name='手机',exact=True)).to_be_disabled()
    expect(dialog.get_by_role('radio',name='电视',exact=True)).to_be_enabled()
    dialog.get_by_role('button',name='取消',exact=True).click()
    assert calls('install')==[]
    results.append('Library remains one APK per card; global installed filter, search and stale-record reinstall selection work')

    dialog=install('麦动')
    expect(dialog.get_by_role('radio',name='手机',exact=True)).to_be_checked()
    dialog.get_by_role('radio',name='电视',exact=True).check()
    page.screenshot(path=os.environ.get('APK_INSTALL_DIALOG_SCREENSHOT','/tmp/install-choice-ui.png'))
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible();assert calls('install')==[]
    dialog=install('麦动')
    dialog.get_by_role('radio',name='电视',exact=True).check()
    page.evaluate('window.fixture.holdInstall=true')
    dialog.get_by_role('button',name='安装到电视',exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(card('麦动').get_by_role('button',name=re.compile('^安装'))).to_be_disabled()
    assert calls('install')==[{'action':'install','id':'maidong','mode':'tv'}]
    assert page.evaluate('window.fixture.state.apps[0].installed')=={}
    goto('桌面');expect(cards).to_have_count(2)
    page.evaluate('window.fixture.resolveInstall({ok:true});window.fixture.holdInstall=false')
    expect(card('麦动','电视')).to_have_count(1)
    expect(cards).to_have_count(3)
    results.append('Install chooser cancellation is inert; busy install is single and does not create a desktop card until success')

    card('麦动','电视').get_by_role('button',name='打开',exact=True).click()
    expect(page.get_by_text('麦动 已在独立窗口打开',exact=True)).to_be_visible()
    assert calls('launch')[-1]=={'action':'launch','id':'maidong','mode':'tv'}
    goto('软件库');dialog=install('麦动')
    expect(dialog.get_by_role('radio',name='电视',exact=True)).to_be_disabled()
    expect(dialog.get_by_role('radio',name='手机',exact=True)).to_be_checked()
    dialog.get_by_role('button',name='安装到手机',exact=True).click()
    expect(card('麦动').get_by_role('button',name='已全部安装',exact=True)).to_be_disabled()
    expect(card('麦动').locator('.mode-tag')).to_have_count(2)
    goto('桌面');expect(cards).to_have_count(4)
    expect(card('麦动')).to_have_count(2)
    card('麦动','手机').get_by_role('button',name='打开',exact=True).click()
    expect(page.get_by_text('麦动 已在独立窗口打开',exact=True)).to_be_visible()
    assert calls('launch')[-1]=={'action':'launch','id':'maidong','mode':'phone'}
    close_notice()
    page.screenshot(path=os.environ.get('APK_INSTALL_UI_SCREENSHOT','/tmp/unified-desktop-ui.png'))
    for width in (1040, 900, 800):
        page.set_viewport_size({'width':width,'height':800})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow at '+str(width)
    page.set_viewport_size({'width':900,'height':800})
    page.screenshot(path=os.environ.get('APK_INSTALL_NARROW_SCREENSHOT','/tmp/unified-desktop-ui-900.png'))
    page.set_viewport_size({'width':1040,'height':800})
    results.append('Same APK installs into both modes; desktop cards have separate mode tags and bound launch targets; layout fits 1040/900/800 px')

    card('麦动','电视').get_by_role('button',name=re.compile('更多操作$')).click()
    card('麦动','电视').get_by_role('button',name='从电视卸载',exact=True).click()
    confirm=page.get_by_role('alertdialog',name='从电视设备卸载应用？')
    expect(confirm).to_be_visible()
    page.evaluate("window.fixture.state.settings.defaultMode='phone';window.fixture.change()")
    expect(confirm).to_be_visible()
    confirm.get_by_role('button',name=re.compile('卸载')).click()
    expect(card('麦动','电视')).to_have_count(0)
    expect(card('麦动','手机')).to_have_count(1)
    assert calls('uninstall')==[{'action':'uninstall','id':'maidong','mode':'tv'}]
    results.append('Uninstall confirmation retains card mode across state refresh and removes only that installation')

    goto('软件库');page.evaluate("window.fixture.nextInstallError='测试安装失败'")
    dialog=install('备用')
    dialog.get_by_role('button',name='安装到手机',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('测试安装失败')
    goto('桌面');expect(card('备用')).to_have_count(0)
    results.append('Failed install exposes error and leaves desktop unchanged')

    goto('软件库')
    page.evaluate('window.fixture.state.managed.licenseAccepted=false;window.fixture.state.managed.tvReady=false;window.fixture.change()')
    dialog=install('备用')
    dialog.get_by_role('radio',name='电视',exact=True).check()
    dialog.get_by_role('button',name='安装到电视',exact=True).click()
    prepare=page.get_by_role('dialog',name='准备电视模拟器')
    expect(prepare).to_be_visible()
    expect(prepare.get_by_role('button',name='同意并准备',exact=True)).to_be_disabled()
    assert calls('prepare')==[]
    prepare.get_by_role('button',name='暂不准备',exact=True).click()
    expect(prepare).not_to_be_visible()
    assert len(calls('install'))==3
    # Retry after cancellation. Consent must prepare and install the selected TV target.
    dialog=install('备用')
    dialog.get_by_role('radio',name='电视',exact=True).check()
    dialog.get_by_role('button',name='安装到电视',exact=True).click()
    expect(prepare).to_be_visible()
    prepare.get_by_role('checkbox').check()
    prepare.get_by_role('button',name='同意并准备',exact=True).click()
    expect(card('备用').locator('.mode-tag')).to_have_text('电视')
    assert calls('prepare')==[{'action':'prepare','mode':'tv','acceptLicense':True}]
    assert calls('install')[-1]=={'action':'install','id':'spare','mode':'tv'}
    results.append('Selected install mode survives license handoff; cancelling is inert; consent prepares and installs only TV')

    page.evaluate('window.fixture.state.managed.phoneReady=false;window.fixture.holdPrepare=true;window.fixture.change()')
    dialog=install('备用')
    dialog.get_by_role('button',name='安装到手机',exact=True).click()
    cancel=page.get_by_role('button',name='取消准备',exact=True)
    expect(cancel).to_be_visible()
    installs_before=len(calls('install'))
    cancel.click()
    expect(page.get_by_text('准备已取消',exact=True)).to_be_visible()
    assert len(calls('install'))==installs_before
    goto('桌面');expect(card('备用','电视')).to_have_count(1);expect(card('备用','手机')).to_have_count(0)
    results.append('Cancelling environment preparation prevents follow-up installation and keeps the other mode card')
    assert not errors, errors
    browser.close()
print(json.dumps({'passed':results,'pageErrors':errors,'scope':'Chromium UI fixture only; no Android installation or native package claim'},ensure_ascii=False,indent=2))
