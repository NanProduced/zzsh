import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countPermissionsByGroup,
  diffPermissionCodes,
  groupAdminPermissions,
  permissionDescription,
  permissionSectionId,
} from '../src/lib/admin-permissions.ts';

// 名称与说明取自 apps/api/migrations/business/0008、0015、0018、0024、0032、0061 的实际 seed 值。
const CATALOG = [
  { code: 'order.read', name: '订单查询', description: '按授权范围查询订单' },
  { code: 'admin.account.read', name: '查看管理员', description: '读取管理员目录与详情' },
  { code: 'admin.account.create', name: '创建管理员', description: '创建普通管理员并交付临时密码' },
  { code: 'admin.account.freeze', name: '冻结管理员', description: '冻结普通管理员登录与会话' },
  { code: 'admin.role.read', name: '查看角色', description: '读取预设角色与权限目录' },
  { code: 'admin.role.configure', name: '配置角色', description: '创建或修改预设角色及其权限' },
  { code: 'admin.audit.read', name: '查询账号与权限审计', description: '读取白名单内的管理员账号、角色、授权与冻结审计' },
  { code: 'content.read', name: '读取游戏内容', description: '按游戏对象范围读取资讯草稿与发布状态' },
  { code: 'content.edit', name: '编辑游戏内容', description: '按游戏对象范围创建和编辑游戏资讯草稿' },
  { code: 'supply.restrict', name: '限制与解除供给', description: '限制或解除指定范围供给' },
  { code: 'widget.mystery.launch', name: '未知域能力', description: '  未登记业务域  ' },
];

test('section id drops only the trailing operation segment', () => {
  assert.equal(permissionSectionId('admin.account.freeze'), 'admin.account');
  assert.equal(permissionSectionId('content.read'), 'content');
  assert.equal(permissionSectionId('order.read'), 'order');
  assert.equal(permissionSectionId('personal.distribution.policy.read'), 'personal.distribution.policy');
});

test('security group splits into objects and leaves single-capability objects unlabelled', () => {
  const security = groupAdminPermissions(CATALOG).find((group) => group.id === 'security');
  assert.ok(security);
  assert.deepEqual(security.codes, ['admin.account.read', 'admin.account.create', 'admin.account.freeze', 'admin.role.read', 'admin.role.configure', 'admin.audit.read']);
  assert.deepEqual(security.sections.map((section) => [section.label, section.codes.length]), [
    ['管理员', 3],
    ['角色', 2],
    ['', 1], // admin.audit.read 单独一项，不硬凑标题
  ]);
  assert.equal(security.sections[2].id, 'admin.audit');
});

test('baseline order.read never enters the role matrix, and unknown domains degrade to a flat row', () => {
  const groups = groupAdminPermissions(CATALOG);
  assert.ok(!groups.some((group) => group.codes.includes('order.read')));
  const other = groups.find((group) => group.id === 'other');
  assert.deepEqual(other.sections, [{ id: 'widget.mystery', label: '', codes: ['widget.mystery.launch'] }]);
});

test('content section keeps its label for a two-segment code', () => {
  const content = groupAdminPermissions(CATALOG).find((group) => group.id === 'content');
  assert.deepEqual(content.sections, [{ id: 'content', label: '游戏内容', codes: ['content.read', 'content.edit'] }]);
});

test('counts are per business domain, exclude baseline, and surface codes missing from the catalog', () => {
  assert.deepEqual(countPermissionsByGroup(['order.read', 'admin.account.freeze', 'content.read'], CATALOG), [
    { id: 'security', label: '平台安全', count: 1 },
    { id: 'content', label: '运营内容', count: 1 },
  ]);
  assert.deepEqual(countPermissionsByGroup(['order.read', 'retired.thing.read'], CATALOG), [
    { id: 'unknown', label: '未归类权限', count: 1 },
  ]);
  assert.deepEqual(countPermissionsByGroup([], CATALOG), []);
});

test('change summary reports added and removed codes in both directions', () => {
  assert.deepEqual(diffPermissionCodes(['content.read', 'content.edit'], ['content.read', 'supply.restrict']), {
    added: ['supply.restrict'],
    removed: ['content.edit'],
  });
  assert.deepEqual(diffPermissionCodes(['content.read'], ['content.read']), { added: [], removed: [] });
});

test('permissions inside one object order read -> create -> update -> dangerous', () => {
  const catalog = [
    ...CATALOG,
    { code: 'admin.account.update', name: '编辑管理员资料', description: '修改显示名称等非身份字段' },
  ];
  const account = groupAdminPermissions(catalog)
    .find((group) => group.id === 'security')
    .sections.find((section) => section.id === 'admin.account');
  assert.deepEqual(account.codes, ['admin.account.read', 'admin.account.create', 'admin.account.update', 'admin.account.freeze']);
});

test('description is trimmed and absent descriptions become an empty string', () => {
  assert.equal(permissionDescription(CATALOG[0]), '按授权范围查询订单');
  assert.equal(permissionDescription({ code: 'x.y', name: 'X' }), '');
  assert.equal(permissionDescription({ code: 'widget.mystery.launch', name: '未知域能力', description: '  未登记业务域  ' }), '未登记业务域');
});
