import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baseRequire = createRequire(path.join(tree, "package.json"));
const React = baseRequire("react");
const { renderToStaticMarkup } = baseRequire("react-dom/server");
const ts = baseRequire("typescript");

const customRequire = (name) => {
  if (name.endsWith(".css")) return {};
  return baseRequire(name);
};

const controlsSource = fs.readFileSync(path.join(tree, "apps/web/src/components/ui/form-controls.tsx"), "utf8");
const compiled = ts.transpileModule(controlsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

// Load module in clean context
const moduleContext = { exports: {} };
const moduleFn = new Function("require", "module", "exports", compiled);
moduleFn(customRequire, moduleContext, moduleContext.exports);
const { Input, Textarea, IntegerStepper, FormSelect, FormRadioGroup, TimeSelect, DateTimePicker } = moduleContext.exports;

test("Input and Textarea maintain backward compatibility and forward standard attributes", () => {
  const htmlInput = renderToStaticMarkup(React.createElement(Input, { id: "test-in", className: "custom-in", defaultValue: "hello", "aria-label": "测试输入" }));
  assert.match(htmlInput, /class="form-input custom-in"/);
  assert.match(htmlInput, /id="test-in"/);
  assert.match(htmlInput, /data-slot="input"/);

  const htmlTextarea = renderToStaticMarkup(React.createElement(Textarea, { id: "test-ta", className: "custom-ta", defaultValue: "desc", "aria-label": "测试文本域" }));
  assert.match(htmlTextarea, /class="form-input custom-ta"/);
  assert.match(htmlTextarea, /id="test-ta"/);
  assert.match(htmlTextarea, /data-slot="textarea"/);
});

test("IntegerStepper default call preserves exact layout and numeric boundaries", () => {
  let changed = null;
  const html = renderToStaticMarkup(React.createElement(IntegerStepper, {
    label: "账号等级",
    value: "10",
    onChange: val => { changed = val; },
    max: "60",
    id: "level-stepper",
  }));

  assert.match(html, /class="form-integer-stepper"/);
  assert.match(html, /aria-label="减少账号等级"/);
  assert.match(html, /aria-label="增加账号等级"/);
  assert.match(html, /id="level-stepper"/);
  assert.match(html, /value="10"/);
  assert.doesNotMatch(html, /is-invalid/);
});

test("IntegerStepper optional pass-throughs support aria-describedby and invalid states", () => {
  const html = renderToStaticMarkup(React.createElement(IntegerStepper, {
    label: "子弹数量",
    value: "abc",
    onChange: () => {},
    invalid: true,
    describedBy: "bullet-err-hint",
    className: "bullet-stepper",
    unit: "发",
  }));

  assert.match(html, /class="form-integer-stepper bullet-stepper is-invalid"/);
  assert.match(html, /data-invalid="true"/);
  assert.match(html, /aria-describedby="bullet-err-hint"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /<span class="form-integer-unit">发<\/span>/);
});

test("IntegerStepper buttons correctly disable on boundaries and disabled prop", () => {
  // Value 0: minus button should be disabled
  const htmlZero = renderToStaticMarkup(React.createElement(IntegerStepper, {
    label: "库存",
    value: "0",
    onChange: () => {},
  }));
  assert.match(htmlZero, /aria-label="减少库存" disabled=""/);
  assert.doesNotMatch(htmlZero, /aria-label="增加库存" disabled=""/);

  // Value at max 60: plus button should be disabled
  const htmlMax = renderToStaticMarkup(React.createElement(IntegerStepper, {
    label: "等级",
    value: "60",
    max: "60",
    onChange: () => {},
  }));
  assert.doesNotMatch(htmlMax, /aria-label="减少等级" disabled=""/);
  assert.match(htmlMax, /aria-label="增加等级" disabled=""/);

  // Entire stepper disabled
  const htmlDisabled = renderToStaticMarkup(React.createElement(IntegerStepper, {
    label: "禁用项",
    value: "5",
    disabled: true,
    onChange: () => {},
  }));
  assert.match(htmlDisabled, /aria-label="减少禁用项" disabled=""/);
  assert.match(htmlDisabled, /aria-label="增加禁用项" disabled=""/);
});

test("FormSelect backward compatibility renders trigger and portal structure", () => {
  const options = [
    { value: "opt1", label: "选项一" },
    { value: "opt2", label: "选项二" },
  ];
  const html = renderToStaticMarkup(React.createElement(FormSelect, {
    label: "段位",
    value: "opt1",
    options,
    placeholder: "请选择段位",
    onChange: () => {},
    id: "grading-select",
  }));

  assert.match(html, /class="form-select-trigger "/);
  assert.match(html, /id="grading-select"/);
  assert.match(html, /aria-label="段位"/);
  assert.match(html, /选项一/);
});

test("FormSelect optional props pass popupClassName and aria-describedby", () => {
  const options = [{ value: "1", label: "档位 1" }];
  const html = renderToStaticMarkup(React.createElement(FormSelect, {
    label: "测试选择",
    value: "",
    options,
    popupClassName: "publish-select-popup",
    describedBy: "grading-help-text",
    hasError: true,
    onChange: () => {},
  }));

  assert.match(html, /aria-describedby="grading-help-text"/);
  assert.match(html, /aria-invalid="true"/);
});

test("FormRadioGroup renders segmented and standard variants with optional errorId", () => {
  const options = [
    { value: "a", label: "选项A" },
    { value: "b", label: "选项B" },
  ];

  // Default variant without error
  const htmlDefault = renderToStaticMarkup(React.createElement(FormRadioGroup, {
    name: "test_radio",
    label: "单选项",
    value: "a",
    options,
    onChange: () => {},
  }));
  assert.match(htmlDefault, /class="form-radio-group "/);
  assert.match(htmlDefault, /is-selected/);
  assert.match(htmlDefault, /选项A/);

  // Segmented variant with external errorId
  const htmlSegmented = renderToStaticMarkup(React.createElement(FormRadioGroup, {
    name: "seg_radio",
    label: "分段单选",
    value: "b",
    options,
    variant: "segmented",
    error: "必须选择一项",
    errorId: "custom-error-id",
    onChange: () => {},
  }));
  assert.match(htmlSegmented, /class="form-radio-group form-radio-group--segmented "/);
  assert.match(htmlSegmented, /aria-describedby="custom-error-id"/);
  assert.match(htmlSegmented, /id="custom-error-id"/);
  assert.match(htmlSegmented, /必须选择一项/);
});

test("TimeSelect and DateTimePicker accept optional popupClassName without breaking", () => {
  const htmlTime = renderToStaticMarkup(React.createElement(TimeSelect, {
    label: "上号时间",
    value: "09:30",
    popupClassName: "publish-select-popup",
    onChange: () => {},
  }));
  assert.match(htmlTime, /class="form-time-select"/);
  assert.match(htmlTime, /09/);
  assert.match(htmlTime, /30/);

  const htmlDate = renderToStaticMarkup(React.createElement(DateTimePicker, {
    label: "有效期",
    value: "2026-10-25T14:00",
    popupClassName: "publish-calendar-popup",
    onChange: () => {},
  }));
  assert.match(htmlDate, /class="form-datetime-picker"/);
  assert.match(htmlDate, /2026\/10\/25/);
});
