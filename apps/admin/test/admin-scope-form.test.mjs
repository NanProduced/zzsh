import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assignedDisabledRoles,
  buildRestoreScopePayload,
  buildScopePayload,
  scopeChoiceError,
  scopeChoiceOf,
  scopeLabel,
} from '../src/lib/admin-scope-form.ts';

test('"无业务范围" 提交空数组，与 "恢复上次范围" 省略 gameIds 是两个不同动作', () => {
  assert.deepEqual(buildScopePayload('zz00002', 'NO_SCOPE', ['game_a', 'game_b']), {
    username: 'zz00002',
    mode: 'SELECTED_GAMES',
    gameIds: [],
  });
  assert.deepEqual(buildRestoreScopePayload('zz00002'), { username: 'zz00002', mode: 'SELECTED_GAMES' });
  assert.equal('gameIds' in buildRestoreScopePayload('zz00002'), false);
});

test('"指定游戏" 提交当前勾选集合，"全部游戏" 提交空数组且模式为 ALL_GAMES', () => {
  assert.deepEqual(buildScopePayload('zz00002', 'SELECTED_GAMES', ['game_a']), {
    username: 'zz00002',
    mode: 'SELECTED_GAMES',
    gameIds: ['game_a'],
  });
  assert.deepEqual(buildScopePayload('zz00002', 'ALL_GAMES', ['game_a']), {
    username: 'zz00002',
    mode: 'ALL_GAMES',
    gameIds: [],
  });
});

test('选了"指定游戏"但没勾任何游戏时拦住保存，不静默提交', () => {
  assert.equal(scopeChoiceError('SELECTED_GAMES', []), '请至少勾选一个游戏，或改选“无业务范围”。');
  assert.equal(scopeChoiceError('SELECTED_GAMES', ['game_a']), null);
  assert.equal(scopeChoiceError('NO_SCOPE', []), null);
  assert.equal(scopeChoiceError('ALL_GAMES', []), null);
});

test('scope 缺失是未知，不是已确认的全部游戏；selected 空集合是"无业务范围"', () => {
  assert.equal(scopeChoiceOf('SELECTED_GAMES', []), 'NO_SCOPE');
  assert.equal(scopeChoiceOf('SELECTED_GAMES', ['game_a']), 'SELECTED_GAMES');
  assert.equal(scopeChoiceOf('ALL_GAMES', []), 'ALL_GAMES');
  assert.equal(scopeChoiceOf(undefined, undefined), null);
  assert.equal(scopeChoiceOf(undefined, []), null);
  assert.equal(scopeLabel(undefined, undefined, []), '未提供');
  assert.equal(scopeLabel('SELECTED_GAMES', [], []), '无业务范围');
  assert.equal(scopeLabel('ALL_GAMES', [], []), '全部游戏');
});

test('部分游戏名未解析时报出总量与未解析数量，不少报范围', () => {
  assert.equal(scopeLabel('SELECTED_GAMES', ['g1', 'g2'], ['三角洲行动']), '三角洲行动 等 2 个指定游戏（1 个名称未解析）');
  assert.equal(scopeLabel('SELECTED_GAMES', ['g1'], ['三角洲行动']), '三角洲行动');
});

test('已分配但已停用的角色被识别出来，而不是从提交载荷里消失', () => {
  const assigned = [
    { id: 'role_active', code: 'ops', name: '运营', status: 'ACTIVE' },
    { id: 'role_dead', code: 'retired', name: '旧岗位', status: 'DISABLED' },
  ];
  assert.deepEqual(assignedDisabledRoles(assigned, new Set(['role_active'])), [assigned[1]]);
  // 两个停用角色都进了 ACTIVE 集合时不应误报；无 id 的条目不可勾选，跳过。
  assert.deepEqual(assignedDisabledRoles(assigned, new Set(['role_active', 'role_dead'])), []);
  assert.deepEqual(assignedDisabledRoles([{ code: 'x', name: '无 id', status: 'DISABLED' }], new Set()), []);
});
