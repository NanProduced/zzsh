// 用已编译 API quotePreview（合成 client，无 DB）生成后台试算面板真实响应夹具。
const path=require('path'),fs=require('fs');const built=path.resolve('apps/api/dist');
const {quotePreview}=require(path.join(built,'src/supply/rules.js'));const {compatRule}=require(path.join(built,'test/pricing-compat-fixture.js'));
const haff=compatRule('57');delete haff.compatibility.modes.fast.max;
const body={priceVersionId:'price_synthetic',expectedRevision:'4',termVersionId:'term_synthetic',conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'fast',ownerRatioB:'63'}},inventory:[{itemId:'haff',quantity:'100000000'}]};
const client={query:async(sql)=>{
 if(sql.includes('"price_version"'))return {rows:[{id:'price_synthetic',gameId:'game_synthetic',mode:'SPREAD',status:'DRAFT',commissionRate:null,haffRule:haff,roundingPolicy:'HALF_UP_CENT_V1',revision:'4'}]};
 if(sql.includes('"term_version"'))return {rows:[{id:'term_synthetic',gameId:'game_synthetic',status:'SEALED',revision:'2'}]};
 if(sql.includes('"term_option"'))return {rows:[{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'}]};
 if(sql.includes('"price_line"'))return {rows:[{itemId:'haff',code:'df_billable_haff',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null}]};
 throw Error('Unexpected '+sql);}};
quotePreview(client,'synthetic_boss',true,body).then(r=>{fs.writeFileSync('apps/admin/test/fixtures/fast-trial-quote-preview.json',JSON.stringify({request:body,haffRule:haff,response:r},null,2)+'\n');const q=r.quote;console.log(JSON.stringify({quotable:r.quotable,res:q.resourceTotal,own:q.ownerTotal,ci:q.pricingInputs.compatibility,den:q.pricingInputs.denominators,P:q.pricingInputs.spreadDelta,buyerHaffRatio:q.buyerHaffRatio}));});
