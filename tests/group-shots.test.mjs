import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentCharacterShots } from "../app/lib/group-shots.js";

const imageByName = new Map([["岳飞", "yuefei.png"], ["秦桧", "qinhui.png"], ["赵构", "zhaogou.png"]]);

function shotsWith(count, characters) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, characters }));
}

function assertConstraint(segments, maxTotal) {
  for (const segment of segments) {
    const total = segment.characterNames.length + segment.shots.length;
    assert.ok(total <= maxTotal, `段内参考角色(${segment.characterNames.length}) + 生成图(${segment.shots.length}) = ${total} 超过上限 ${maxTotal}`);
  }
}

test("单角色 10 张 → 1 段，全部塞进", () => {
  const segments = segmentCharacterShots(shotsWith(10, ["岳飞"]), imageByName, 15);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].shots.length, 10);
  assert.deepEqual(segments[0].characterNames, ["岳飞"]);
  assertConstraint(segments, 15);
});

test("单角色 14 张 → 1 段（边界：1 参考 + 14 生成 = 15）", () => {
  const segments = segmentCharacterShots(shotsWith(14, ["岳飞"]), imageByName, 15);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].shots.length, 14);
  assertConstraint(segments, 15);
});

test("单角色 15 张 → 2 段（14 + 1，因为 1 参考 + 15 生成超限）", () => {
  const segments = segmentCharacterShots(shotsWith(15, ["岳飞"]), imageByName, 15);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].shots.length, 14);
  assert.equal(segments[1].shots.length, 1);
  assertConstraint(segments, 15);
});

test("单角色 20 张 → 2 段（14 + 6）", () => {
  const segments = segmentCharacterShots(shotsWith(20, ["岳飞"]), imageByName, 15);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].shots.length, 14);
  assert.equal(segments[1].shots.length, 6);
  assertConstraint(segments, 15);
});

test("双角色全程出场 14 张 → 2 段（2 参考最多配 13 生成）", () => {
  const segments = segmentCharacterShots(shotsWith(14, ["岳飞", "秦桧"]), imageByName, 15);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].shots.length, 13);
  assert.equal(segments[1].shots.length, 1);
  assert.deepEqual(segments[0].characterNames, ["岳飞", "秦桧"]);
  assertConstraint(segments, 15);
});

test("角色切换导致切段：岳飞段 → 秦桧段", () => {
  const shots = [
    { id: "a1", characters: ["岳飞"] },
    { id: "a2", characters: ["岳飞"] },
    { id: "b1", characters: ["秦桧"] },
    { id: "b2", characters: ["秦桧"] },
  ];
  const segments = segmentCharacterShots(shots, imageByName, 15);
  // 引入新角色（秦桧）即切段 → 2 段
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].characterNames, ["岳飞"]);
  assert.equal(segments[0].shots.length, 2);
  assert.deepEqual(segments[1].characterNames, ["秦桧"]);
  assert.equal(segments[1].shots.length, 2);
});

test("段内参考角色聚焦：不混入无关角色", () => {
  const shots = [
    { id: "1", characters: ["岳飞", "大理寺狱吏"] },
    { id: "2", characters: ["岳飞"] },
    { id: "3", characters: ["岳飞"] },
    { id: "4", characters: ["秦桧"] },
  ];
  const map = new Map([["岳飞", "yf"], ["大理寺狱吏", "yl"], ["秦桧", "qh"]]);
  const segments = segmentCharacterShots(shots, map, 15);
  // shot1-3 岳飞主场，shot4 引入秦桧 → 切段，秦桧不会混进岳飞段的参考图
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].characterNames, ["岳飞", "大理寺狱吏"]);
  assert.equal(segments[0].shots.length, 3);
  assert.deepEqual(segments[1].characterNames, ["秦桧"]);
  assert.equal(segments[1].shots.length, 1);
});

test("无角色标签 / 未知角色名 → 不计入参考角色", () => {
  const shots = [
    { id: "x1", characters: [] },
    { id: "x2", characters: ["路人甲"] }, // 不在图库里
    { id: "x3", characters: ["岳飞"] },
  ];
  const segments = segmentCharacterShots(shots, imageByName, 15);
  // 路人甲不在图库被过滤；岳飞引入触发切段，但「路人甲」不会出现在任何段
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].characterNames, []);
  assert.equal(segments[0].shots.length, 2);
  assert.deepEqual(segments[1].characterNames, ["岳飞"]);
  assert.equal(segments[1].shots.length, 1);
  for (const segment of segments) assert.ok(!segment.characterNames.includes("路人甲"));
});

test("空列表 → 0 段", () => {
  assert.deepEqual(segmentCharacterShots([], imageByName, 15), []);
});
