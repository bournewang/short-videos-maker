// 分段组图编排：把「人物镜头」切成若干段，每段满足 Seedream 组图的硬约束
// 「参考图数 + 生成图数 ≤ maxTotalImages」（默认 15，见 render-service 的 MAX_GROUP_IMAGES）。
//
// 切段策略：除了「超限」外，一旦新 shot 引入当前段没有的新角色就切段，
// 保证每段组图的参考图只锚定「该段真正出场的角色」，避免把无关角色一起 reference。

export function segmentCharacterShots(shots, imageByName, maxTotalImages = 15) {
  const segments = [];
  let current = { shots: [], characterNames: new Set() };
  for (const shot of shots) {
    const names = (Array.isArray(shot.characters) ? shot.characters : []).filter((name) => imageByName.has(name));
    const mergedNames = new Set([...current.characterNames, ...names]);
    const introducesNewCharacter = names.some((name) => !current.characterNames.has(name));
    const exceedsLimit = mergedNames.size + current.shots.length + 1 > maxTotalImages;
    if (current.shots.length && (exceedsLimit || introducesNewCharacter)) {
      segments.push({ shots: current.shots, characterNames: [...current.characterNames] });
      current = { shots: [], characterNames: new Set() };
    }
    current.shots.push(shot);
    names.forEach((name) => current.characterNames.add(name));
  }
  if (current.shots.length) segments.push({ shots: current.shots, characterNames: [...current.characterNames] });
  return segments;
}
