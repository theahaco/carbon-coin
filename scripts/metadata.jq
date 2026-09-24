# XLS-89 compact names; byte encoding is handled by xrpl --mptoken-metadata @FILE.
{
  t:env.TOKEN_TICKER, n:env.TOKEN_NAME, i:env.TOKEN_ICON_URL,
  ac:env.TOKEN_ASSET_CLASS, in:env.TOKEN_ISSUER_NAME,
  d:env.TOKEN_DESCRIPTION, as:env.TOKEN_ASSET_SUBCLASS
}
| with_entries(select(.value != null and .value != ""))
| if ([.t,.n,.i,.ac,.in] | all(type == "string" and length > 0)) | not
  then error("Missing required TOKEN_* identity variables; see .env.example") else . end
| if (.t | test("^[A-Z0-9]{1,6}$")) | not then error("Invalid TOKEN_TICKER") else . end
| if (.ac | IN("rwa","memes","wrapped","gaming","defi","other")) | not
  then error("Invalid TOKEN_ASSET_CLASS") else . end
| if (.ac == "rwa" and .as == null) or (.as != null and (.as | IN("stablecoin","commodity","real_estate","private_credit","equity","treasury","other") | not))
  then error("Invalid TOKEN_ASSET_SUBCLASS") else . end
