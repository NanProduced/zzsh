CREATE TABLE zzsh_supply.favorite (
  user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,account_id)
);
CREATE INDEX favorite_user_page ON zzsh_supply.favorite(user_id,created_at DESC,account_id DESC);
