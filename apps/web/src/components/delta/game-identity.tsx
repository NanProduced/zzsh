import type { ReactNode } from "react";
import "./game-sections.css";

const games = {
  delta: { name: "三角洲行动", caption: "资源租号 · 按消耗计费", art: "hackclaw-scene-v2.png" },
  valorant: { name: "无畏契约", caption: "VALORANT", art: "reyna-owner-selected.png" },
  league: { name: "英雄联盟", caption: "LEAGUE OF LEGENDS", art: "kaisa-kda-scene-v2.png" },
};
export function GameIdentity({ game, children }: { game: keyof typeof games; children?: ReactNode }) {
  const item = games[game];
  return <div className={`game-identity game-identity--${game}`}>
    <div className="game-portrait" style={{ backgroundImage: `url(/art/games/${item.art})` }} aria-hidden="true" />
    <div className="game-identity-heading"><h2>{item.name}</h2><p>{item.caption}</p></div>
    {children && <div className="game-identity-actions">{children}</div>}
  </div>;
}
export function UpcomingGames() {
  return <>{(["valorant", "league"] as const).map(game => <section key={game} className="portal-width game-row game-row--upcoming" aria-label={`${games[game].name}专区`}>
    <GameIdentity game={game} />
    <div className="game-coming-soon"><p>COMING SOON</p><h3>{games[game].name}专区筹备中</h3><span>敬请期待</span></div>
  </section>)}</>;
}

