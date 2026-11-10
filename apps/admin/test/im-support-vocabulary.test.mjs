import test from "node:test";
import assert from "node:assert/strict";
import {
  VOCABULARY_UNKNOWN_FALLBACK,
  CONSULTATION_TYPE_VOCABULARY,
  CONSULTATION_STATE_VOCABULARY,
  CONSULTATION_EVENT_VOCABULARY,
  AGENT_AVAILABILITY_VOCABULARY,
  ORDER_PARTY_VOCABULARY,
  ACCOUNT_STATUS_VOCABULARY,
  HISTORY_STATE_VOCABULARY,
  formatVocabulary,
  formatEventMovement,
} from "../src/views/im-support-vocabulary.ts";

test("im-support-vocabulary: standard mappings return correct business terms", () => {
  assert.equal(formatVocabulary(CONSULTATION_TYPE_VOCABULARY, "SERVICE"), "普通咨询");
  assert.equal(formatVocabulary(CONSULTATION_TYPE_VOCABULARY, "COMPLAINT"), "投诉建议");
  assert.equal(formatVocabulary(CONSULTATION_TYPE_VOCABULARY, "ORDER"), "订单群");

  assert.equal(formatVocabulary(CONSULTATION_STATE_VOCABULARY, "WAITING"), "待接入");
  assert.equal(formatVocabulary(CONSULTATION_STATE_VOCABULARY, "ACTIVE"), "接待中");
  assert.equal(formatVocabulary(CONSULTATION_STATE_VOCABULARY, "CLOSED"), "已结束");

  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "CREATED"), "发起咨询");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "ASSIGNED"), "系统分配");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "CLAIMED"), "客服接入");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "TRANSFERRED"), "转交");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "CLOSED"), "结束咨询");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "REOPENED"), "重新开启");
  assert.equal(formatVocabulary(CONSULTATION_EVENT_VOCABULARY, "UNKNOWN"), "未知类型");

  assert.equal(formatVocabulary(AGENT_AVAILABILITY_VOCABULARY, "AVAILABLE"), "正常接单");
  assert.equal(formatVocabulary(AGENT_AVAILABILITY_VOCABULARY, "PAUSED"), "暂停接单");
  assert.equal(formatVocabulary(AGENT_AVAILABILITY_VOCABULARY, "OFF_DUTY"), "离线");

  assert.equal(formatVocabulary(ORDER_PARTY_VOCABULARY, "RENTER"), "租客");
  assert.equal(formatVocabulary(ORDER_PARTY_VOCABULARY, "OWNER"), "号主");

  assert.equal(formatVocabulary(ACCOUNT_STATUS_VOCABULARY, "ACTIVE"), "账号正常");
  assert.equal(formatVocabulary(ACCOUNT_STATUS_VOCABULARY, "RESTRICTED"), "账号受限");
  assert.equal(formatVocabulary(ACCOUNT_STATUS_VOCABULARY, "FROZEN"), "已冻结");
  assert.equal(formatVocabulary(ACCOUNT_STATUS_VOCABULARY, "CANCELLED"), "已注销");

  assert.equal(formatVocabulary(HISTORY_STATE_VOCABULARY, "AVAILABLE"), "已就绪");
  assert.equal(formatVocabulary(HISTORY_STATE_VOCABULARY, "NOT_ESTABLISHED"), "尚未建立");
  assert.equal(formatVocabulary(HISTORY_STATE_VOCABULARY, "LEGACY_UNAVAILABLE"), "历史暂不可读");
  assert.equal(formatVocabulary(HISTORY_STATE_VOCABULARY, "RECOVERING"), "正在同步");
});

test("im-support-vocabulary: missing or unknown enums fall back cleanly without leaking codes", () => {
  const dicts = [
    CONSULTATION_TYPE_VOCABULARY,
    CONSULTATION_STATE_VOCABULARY,
    CONSULTATION_EVENT_VOCABULARY,
    AGENT_AVAILABILITY_VOCABULARY,
    ORDER_PARTY_VOCABULARY,
    ACCOUNT_STATUS_VOCABULARY,
    HISTORY_STATE_VOCABULARY,
  ];

  for (const dict of dicts) {
    assert.equal(formatVocabulary(dict, undefined), VOCABULARY_UNKNOWN_FALLBACK);
    assert.equal(formatVocabulary(dict, null), VOCABULARY_UNKNOWN_FALLBACK);
    assert.equal(formatVocabulary(dict, ""), VOCABULARY_UNKNOWN_FALLBACK);
    assert.equal(formatVocabulary(dict, "   "), VOCABULARY_UNKNOWN_FALLBACK);
    assert.equal(formatVocabulary(dict, "NON_EXISTENT_ENUM"), VOCABULARY_UNKNOWN_FALLBACK);
    if (dict === CONSULTATION_EVENT_VOCABULARY) {
      assert.equal(formatVocabulary(dict, "UNKNOWN"), "未知类型");
    } else {
      assert.equal(formatVocabulary(dict, "UNKNOWN"), VOCABULARY_UNKNOWN_FALLBACK);
    }
  }
});

test("im-support-vocabulary: event move formatting suppresses self loops", () => {
  // from === to -> only display name once, no arrow
  assert.equal(formatEventMovement("张三", "张三"), "张三");
  assert.equal(formatEventMovement(" 客服A ", "客服A"), "客服A");

  // from !== to -> normal movement
  assert.equal(formatEventMovement("系统", "客服A"), "系统 → 客服A");
  assert.equal(formatEventMovement("客服A", "客服B"), "客服A → 客服B");

  // one side missing
  assert.equal(formatEventMovement("客服A", null), "客服A");
  assert.equal(formatEventMovement(null, "客服B"), "客服B");
  assert.equal(formatEventMovement("", "客服B"), "客服B");

  // both missing
  assert.equal(formatEventMovement(null, null), null);
  assert.equal(formatEventMovement("", ""), null);
});

test("im-support-vocabulary: no banned engineering jargon in user/operator facing terms", () => {
  const bannedWords = [
    "服务端",
    "WAITING",
    "ACTIVE",
    "CLOSED",
    "presence",
    "SDK",
    "云信",
    "NIM",
    "scope",
    "快照",
    "幂等",
    "重放",
    "未冲销",
    "口径缺口",
    "quality.firstResponse",
    "quality.resolution",
  ];

  const allVocabularies = [
    CONSULTATION_TYPE_VOCABULARY,
    CONSULTATION_STATE_VOCABULARY,
    CONSULTATION_EVENT_VOCABULARY,
    AGENT_AVAILABILITY_VOCABULARY,
    ORDER_PARTY_VOCABULARY,
    ACCOUNT_STATUS_VOCABULARY,
    HISTORY_STATE_VOCABULARY,
  ];

  for (const dict of allVocabularies) {
    for (const [key, value] of Object.entries(dict)) {
      for (const banned of bannedWords) {
        assert.ok(
          !value.toLowerCase().includes(banned.toLowerCase()),
          `Vocabulary "${key}": "${value}" should not contain banned word "${banned}"`
        );
      }
    }
  }

  // Also verify default fallback doesn't contain banned words
  for (const banned of bannedWords) {
    assert.ok(
      !VOCABULARY_UNKNOWN_FALLBACK.toLowerCase().includes(banned.toLowerCase()),
      `Fallback should not contain banned word "${banned}"`
    );
  }
});
