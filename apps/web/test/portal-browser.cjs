async (page) => {
 const report = [];
 const check = (name, pass, detail = '') => { report.push({name, pass, detail}); };
 await page.emulateMedia({reducedMotion: 'reduce'});
 for (const width of [1440,768,390]) {
   await page.setViewportSize({width, height: width===390 ? 844 : 900});
   for (const theme of ['dark','light']) {
     await page.goto('http://127.0.0.1:3180/');
     await page.evaluate(t => { localStorage.setItem('zzsh-user-theme', t); }, theme);
     await page.reload(); await page.evaluate(() => document.fonts.ready);
     
     check('viewport-'+width+'-'+theme, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), await page.locator('.hero-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns));
     check('hero-portrait-popout-'+width+'-'+theme, await page.locator('.hero-carousel').evaluate(hero=>{
       const slide=hero.querySelector('.hero-slide[aria-hidden="false"]');
       const portrait=slide.querySelector('.hero-character-shell').getBoundingClientRect();
       const scene=slide.querySelector('.hero-scene').getBoundingClientRect();
       const viewport=hero.querySelector('.hero-viewport').getBoundingClientRect();
       const header=document.querySelector('.portal-header').getBoundingClientRect();
       return scene.top-portrait.top>=20 && portrait.top>=header.bottom+6 && portrait.top>=viewport.top+6
         && getComputedStyle(slide).overflow==='visible' && getComputedStyle(hero.querySelector('.hero-viewport')).overflow==='clip'
         && hero.querySelector('.hero-viewport').scrollTop===0;
     }));
     check('readable-help-'+width+'-'+theme, await page.locator('.help-grid p').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=14));
     check('touch-controls-'+width+'-'+theme, await page.locator('.carousel-controls button, .supply-heading a').evaluateAll(els=>els.every(el=>{const r=el.getBoundingClientRect();return r.width>=44 && r.height>=44;})));
     check('no-overlapping-carousel-targets-'+width+'-'+theme, await page.locator('.carousel-controls button').evaluateAll(els=>els.every((el,i)=>i===0 || els[i-1].getBoundingClientRect().right<=el.getBoundingClientRect().left)));
     check('publish-guide-label-'+width+'-'+theme, await page.locator('.publish-link').innerText()==='发布须知');
     check('visitor-copy-'+width+'-'+theme, !(await page.locator('.personal-panel').innerText()).includes('未知'));
   }
 }
 await page.setViewportSize({width:1440,height:900});
 await page.goto('http://127.0.0.1:4210/');
 await page.evaluate(() => document.fonts.ready);
 
 check('fixture-card-count', await page.locator('.account-card').count()===3);
 check('missing-and-failed-images', (await page.getByText('图片未提供',{exact:true}).count())===2 && (await page.getByText('图片加载失败',{exact:true}).count())===1);
 for (const state of ['loading','empty','error','unavailable']) {
   await page.getByLabel('展示状态').selectOption(state);
   check('showcase-'+state, state==='loading' ? await page.getByRole('status',{name:'正在加载账号'}).count()===1 : await page.locator('.account-empty').count()===1);
 }
 await page.getByLabel('展示状态').selectOption('ready');
 for (const width of [1440,768,390]) {
   await page.setViewportSize({width,height:900});
   await page.getByLabel('展示状态').selectOption('long');
   const card=page.locator('.account-card').first();
   check('long-content-'+width, await card.evaluate(el=>{
     const content=el.querySelector('.account-content');
     return content.scrollWidth<=content.clientWidth && el.querySelector('h3').textContent.length>100 && getComputedStyle(el.querySelector('h3')).webkitLineClamp==='none';
   }));
   check('full-fees-'+width, await card.locator('.account-fees').innerText().then(t=>t.includes('99,999,999.99') && t.includes('88,888,888.88')));
   check('readable-card-'+width, await card.locator('.account-resources, .account-terms dt, .account-fees dt').evaluateAll(els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=12)));
   check('card-targets-'+width, await card.locator('.favorite, .account-detail').evaluateAll(els=>els.every(el=>el.getBoundingClientRect().height>=44)));
 }
 await page.getByLabel('展示状态').selectOption('ready');
 await page.setViewportSize({width:768,height:900});
 
 await page.setViewportSize({width:390,height:844});
 
 await page.goto('http://127.0.0.1:3180/');
 await page.getByRole('button',{name:'打开导航菜单'}).focus();
 await page.keyboard.press('Space');
 await page.getByRole('dialog',{name:'移动端菜单'}).waitFor();
 check('drawer-space-opens-focus-inside', await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')));
 for(let i=0;i<16;i++){await page.keyboard.press('Tab'); check('drawer-tab-trap-'+i,await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')));}
 await page.keyboard.press('Shift+Tab');
 check('drawer-reverse-tab',await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')));
 check('drawer-background-hidden',await page.locator('.portal-home').getAttribute('aria-hidden')==='true');
 
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='打开导航菜单');
 check('drawer-escape-and-return',await page.getByRole('dialog').count()===0 && await page.getByRole('button',{name:'打开导航菜单'}).evaluate(el=>el===document.activeElement));
 await page.getByRole('button',{name:'打开导航菜单'}).click();
 await page.getByRole('dialog').getByRole('link',{name:'帮助中心与规则'}).click();
 check('drawer-navigation',page.url().endsWith('#help') && await page.getByRole('dialog').count()===0);
 await page.getByRole('button',{name:'查看结算规则',exact:true}).focus();
 await page.keyboard.press('Space'); await page.getByRole('dialog').waitFor();
 check('dialog-space-opens-focus-inside',await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')));
 for(let i=0;i<5;i++){await page.keyboard.press('Tab'); check('dialog-tab-trap-'+i,await page.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')));}
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.textContent==='查看结算规则');
 check('dialog-escape-and-return',await page.getByRole('dialog').count()===0 && await page.getByRole('button',{name:'查看结算规则',exact:true}).evaluate(el=>el===document.activeElement));
 await page.setViewportSize({width:1440,height:900});
 await page.goto('http://127.0.0.1:3180/');
 const hero=page.getByRole('region',{name:'平台指南轮播'});
 check('reduced-no-autoplay',await hero.getAttribute('data-autoplay')==='false');
 check('reduced-disabled-control',await page.getByRole('button',{name:'减少动态：自动播放已关闭'}).isDisabled());
 await page.getByRole('button',{name:'切换到幻灯片 2'}).click();
 await page.getByRole('button',{name:'查看计费说明',exact:true}).focus();
 await page.keyboard.press('Space'); await page.getByRole('dialog').waitFor();
 check('carousel-internal-space-button',await page.getByRole('dialog',{name:'资源费用与结算'}).count()===1);
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
 check('carousel-dialog-focus-return',await page.getByRole('button',{name:'查看计费说明',exact:true}).evaluate(el=>el===document.activeElement));
 await page.getByRole('button',{name:'切换到幻灯片 1'}).click();
 const tabTargets=[];
 for(let i=0;i<12;i++){await page.keyboard.press('Tab'); tabTargets.push(await page.evaluate(()=>({text:document.activeElement?.textContent,hidden:!!document.activeElement?.closest('[inert]')})));}
 check('hidden-slides-not-tabbed',tabTargets.every(x=>!x.hidden),JSON.stringify(tabTargets));
 await hero.focus(); await page.keyboard.press('ArrowRight');
 check('carousel-root-arrow',await hero.getAttribute('data-current-slide')==='2');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.reload(); await page.mouse.move(1,1);
 await page.waitForTimeout(6000);
 check('autoplay-advances',await hero.getAttribute('data-current-slide')!=='1');
 await hero.focus();
 const focused=await hero.getAttribute('data-current-slide');
 await page.waitForTimeout(6000);
 check('focus-pauses-autoplay',await hero.getAttribute('data-current-slide')===focused);
 await page.getByRole('button',{name:'切换到幻灯片 1'}).click();
 await page.locator('.header-inner').getByRole('link',{name:'洲洲商行首页'}).focus();
 await page.mouse.move(1,1); await page.waitForTimeout(6000);
 check('manual-change-stays-paused',await hero.getAttribute('data-current-slide')==='1');
 await page.getByRole('button',{name:'开始自动播放'}).focus(); await page.keyboard.press('Space');
 check('explicit-keyboard-play-effective-with-focus',await hero.getAttribute('data-autoplay')==='true');
 check('play-does-not-move-focus',await page.getByRole('button',{name:'暂停自动播放'}).evaluate(el=>el===document.activeElement));
 const explicitStart=await hero.getAttribute('data-current-slide');
 await page.waitForTimeout(6000);
 check('explicit-keyboard-play-advances-with-focus',await hero.getAttribute('data-current-slide')!==explicitStart);
 await page.keyboard.press('Space');
 check('space-pauses-on-same-button',await hero.getAttribute('data-autoplay')==='false');
 await page.getByRole('button',{name:'开始自动播放'}).click();
 await page.mouse.move(1,1);
 const mouseStart=await hero.getAttribute('data-current-slide');
 await page.waitForTimeout(6000);
 check('explicit-mouse-play-with-focus',await hero.getAttribute('data-current-slide')!==mouseStart && await page.getByRole('button',{name:'暂停自动播放'}).evaluate(el=>el===document.activeElement));
 await page.getByRole('button',{name:'下一张幻灯片'}).focus();
 check('new-inner-focus-stops-explicit-play',await hero.getAttribute('data-autoplay')==='false');
 await page.getByRole('button',{name:'开始自动播放'}).click();
 await page.locator('.header-inner').getByRole('link',{name:'洲洲商行首页'}).focus();
 const leaveStart=await hero.getAttribute('data-current-slide');
 await page.mouse.move(1,1); await page.waitForTimeout(6000);
 check('explicit-resume-after-focus-leaves',await hero.getAttribute('data-current-slide')!==leaveStart);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.getByRole('button',{name:'减少动态：自动播放已关闭'}).waitFor();
 check('reduced-stops-manual-play',await hero.getAttribute('data-autoplay')==='false');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.getByRole('button',{name:'开始自动播放'}).waitFor();
 const reducedExit=await hero.getAttribute('data-current-slide');
 await page.waitForTimeout(6000);
 check('leaving-reduced-needs-explicit-play',await hero.getAttribute('data-autoplay')==='false');
 check('leaving-reduced-stays-static',await hero.getAttribute('data-current-slide')===reducedExit);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.reload(); const reducedStart=await hero.getAttribute('data-current-slide');
 await page.waitForTimeout(5800);
 check('reduced-remains-static',await hero.getAttribute('data-current-slide')===reducedStart);
 await page.getByRole('button',{name:'浅色',exact:true}).click();
 check('theme-button',await page.locator('html').getAttribute('data-theme')==='light');
 await page.reload(); check('theme-persists',await page.locator('html').getAttribute('data-theme')==='light');
 await page.emulateMedia({colorScheme:'dark'}); await page.getByRole('button',{name:'系统',exact:true}).click();
 check('system-dark',await page.locator('html').getAttribute('data-theme')==='dark');
 await page.emulateMedia({colorScheme:'light'}); await page.waitForTimeout(150);
 check('system-reacts',await page.locator('html').getAttribute('data-theme')==='light');

 // Real Chromium touch input, no synthetic React handler calls.
 await page.setViewportSize({width:390,height:844}); await page.goto('http://127.0.0.1:3180/');
 await page.getByRole('button',{name:'切换到幻灯片 1'}).click();
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const box=await page.locator('.hero-viewport').boundingBox();
 const startX=box.x+box.width-40, y=box.y+45;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y}]});
 for(let step=1;step<=7;step++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX-step*35,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(800);
 check('touch-swipe-changes-slide',await hero.getAttribute('data-current-slide')!=='1');
 check('touch-stops-autoplay',await hero.getAttribute('data-autoplay')==='false');
 check('hero-does-not-scroll-vertically-after-drag',await hero.evaluate(el=>{
   const viewport=el.querySelector('.hero-viewport'),scene=el.querySelector('.hero-slide[aria-hidden="false"] .hero-scene');
   return viewport.scrollTop===0 && Math.abs(scene.getBoundingClientRect().top-el.getBoundingClientRect().top)<1;
 }));
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false}); await cdp.detach();
 for(const index of [2,3]){
   await page.getByRole('button',{name:'切换到幻灯片 '+index}).click();
   
 }
 await page.route('**/art/**',route=>route.abort());
 await page.reload(); await page.waitForTimeout(150);
 check('failed-hero-image-copy-remains',await page.getByRole('heading',{name:'玩得更远， 一直有洲洲。'}).count()===1);
 check('failed-hero-image-action-remains',await page.getByRole('link',{name:'挑选三角洲账号'}).isVisible());
 
 await page.unroute('**/art/**');
 await page.setViewportSize({width:1440,height:900}); await page.goto('http://127.0.0.1:3180/');
 await page.getByRole('button',{name:'深色',exact:true}).click();
 await page.getByRole('button',{name:'切换到幻灯片 1'}).click();
 await page.locator('.header-inner').getByRole('link',{name:'洲洲商行首页'}).focus(); await page.keyboard.press('Tab');
 
 const noNetwork = await page.evaluate(() => performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('/api/') || !n.startsWith(location.origin)));
 check('home-no-api-or-external-resources',noNetwork.length===0,JSON.stringify(noNetwork));
 const failures=report.filter(r=>!r.pass);
 if (failures.length) throw new Error(JSON.stringify(failures));
 return {checks:report,failed:failures.length,passed:report.length-failures.length};

}
