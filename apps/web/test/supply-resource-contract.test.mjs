import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toListingCard,resourceQuantityLabel} from '../src/lib/listing-view.ts';
import * as listingView from '../src/lib/listing-view.ts';
import * as listingFilters from '../src/lib/listing-filters.ts';
import {createRequire,Module} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

test('actual list and grid render Barrett and piece-count insurance even after the original four resources',()=>{
  const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const require=createRequire(path.join(tree,'package.json')),React=require('react');
  const file=path.join(tree,'apps/web/src/components/delta/account-card.tsx');
  const module=new Module(file);module.filename=file;module.paths=Module._nodeModulePaths(tree);
  module.require=name=>{
    if(name==='next/link')return ({children,href,...props})=>React.createElement('a',{href,...props},children);
    if(name==='@/lib/listing-view')return listingView;
    if(name==='@/lib/listing-filters')return listingFilters;
    if(name==='@/lib/account-return')return {rememberAccountReturn:()=>{}};
    if(name==='./login-method-icon')return {LoginMethodIcon:()=>null};
    if(name==='@/components/favorites/favorite-button')return {FavoriteButton:()=>null};
    if(name==='@/components/ui/tooltip')return Object.fromEntries(['Tooltip','TooltipContent','TooltipTrigger'].map(key=>[key,({children})=>React.createElement(React.Fragment,null,children)]));
    if(name==='@/components/ui/thumbnail-carousel')return {ThumbnailCarousel:()=>null};
    return require(name);
  };
  module._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
  const resources=[['level6_armor','护甲','件'],['level6_helmet','头盔','件'],['level6_round','六级子弹','发'],['awm_round','AWM','发'],['df_billable_barrett_bullet','巴雷特子弹','发'],['top_insure_card_piece','顶级保险卡','张'],['df_billable_top_insure_card','旧保险体验卡','天']].map(([code,name,unitLabel])=>({itemId:code,code,name,quantity:'3',quantityLabel:'3',unitLabel,costAmount:null,costLabel:null,unitPriceLabel:null}));
  const data={id:'fixture',title:'资源合同测试',displayNo:null,media:[],resourceLines:resources,resourceTotalLabel:'待确认',haffRentLabel:null,itemResourceTotalLabel:null,depositLabel:null,payableTotalLabel:null,termLabel:'6 天',termOptionLabel:null,conditionLines:[],loginMethod:null,skinNames:[],skinLabels:[],skinTags:[],entitlementNames:[],unitAmountsInformational:false};
  for(const viewMode of ['list','grid']){
    const html=require('react-dom/server').renderToStaticMarkup(React.createElement(module.exports.AccountCard,{data,viewMode}));
    assert.match(html,/巴雷特子弹/);assert.match(html,/顶级保险卡/);
    assert.match(html,/3发/);assert.match(html,/3张/);assert.match(html,/3天/);
    assert.doesNotMatch(html,/查看其余|更多资源见详情/);
  }
});

test('public resource projections preserve all eight facts and never turn frozen days into cards',()=>{
  const items=[['haff','haff_base','HAFF_BASE','2000000','1000000'],['six','level6_round','ROUND','120','60'],['awm','awm_round','ROUND','2','1'],['barrett','df_billable_barrett_bullet','ROUND','2','1'],['armor','level6_armor','PIECE','0','1'],['helmet','level6_helmet','PIECE','1','1'],['coffee','coffee','PIECE','1','1'],['card','top_insure_card_piece','PIECE','3','1'],['old-card','df_billable_top_insure_card','DAY','4','1']];
  const money=amount=>({currency:'CNY',unit:'yuan',amount,scale:2});
  const listing={id:'synthetic',title:'synthetic contract',attributes:{},description:null,media:[],presentation:{items:items.map(([id,code,unit])=>({id,code,unit,name:code})),skins:[],entitlements:[]},quote:{lines:items.map(([itemId,,unit,quantity,unitQuantity])=>({itemId,unit,quantity,unitQuantity,buyerAmount:money('1.00'),buyerUnitAmount:money('1.00')})),resourceTotal:money('9.00'),tenantDeposit:null,tenantPayableTotal:null,termSeconds:'86400',expiryDisclosures:[]}};
  const card=toListingCard(listing);
  assert.equal(card.resourceLines.length,9);
  const line=id=>card.resourceLines.find(row=>row.itemId===id);
  assert.equal(line('six').quantityLabel,'2组（120发）');
  assert.equal(line('awm').quantity,'2');assert.equal(line('barrett').quantity,'2');
  assert.equal(resourceQuantityLabel(line('armor')),'0件');
  assert.equal(resourceQuantityLabel(line('card')),'3张');
  assert.equal(resourceQuantityLabel(line('old-card')),'4天');
  assert.equal(resourceQuantityLabel(line('coffee')),'1件');
  assert.equal(card.depositLabel,null);
});
