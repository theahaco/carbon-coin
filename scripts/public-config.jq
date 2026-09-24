# An allowlist, never recursive removal of selected secret fields.
def public_account:
  if . == null then null else {address,quorum,signers:[.signers[] | {address}]} end;
{
  network, mptIssuanceId,
  token: {
    ticker:env.TOKEN_TICKER, name:env.TOKEN_NAME,
    description:env.TOKEN_DESCRIPTION, icon:env.TOKEN_ICON_URL,
    issuerName:env.TOKEN_ISSUER_NAME
  },
  issuer:(.issuer | public_account), governance:(.governance | public_account)
}
| walk(if type == "object" then with_entries(select(.value != null)) else . end)
