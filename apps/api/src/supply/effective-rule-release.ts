/** SQL aliases and clocks are supplied only by server queries. Legacy rows retain the initial game pointer. */
export function effectiveRuleRelease(game: string, at = "transaction_timestamp()") {
  const effective = "scheduled.activated_at";
  return `COALESCE((SELECT scheduled.id FROM zzsh_supply.rule_release scheduled
    WHERE scheduled.game_id=${game}.id AND to_jsonb(scheduled)->>'effective_at' IS NOT NULL AND ${effective}<=${at}
    ORDER BY ${effective} DESC, scheduled.generation DESC LIMIT 1), ${game}.current_release_id)`;
}
