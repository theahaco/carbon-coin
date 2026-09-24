import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, RippledError } from 'xrpl'
import { describeReadiness } from '../../src/lib/readiness'
import { checkTransfer } from '../../src/lib/xrplClient'

const ISSUANCE = '013FF064D26B0039BF8C5440F2F6A96AD315F996B25EF837'
const REGISTER = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const DESK = 'rB6b46dDoxhJtnJ52w5BtErYBazapCpCAD'
const INVESTOR = 'rUTE43GKdqLK3RkyBmKdczRdQFDSWCceaQ'
/** Ledger flag lsfMPTCanTransfer. */
const LSF_MPT_CAN_TRANSFER = 0x00000020

/** Answers the SDK's own readiness reads: the Desk holds `deskUnits`, the investor holds nothing. */
function mockLedger(deskUnits: string, issuanceFlags = LSF_MPT_CAN_TRANSFER) {
  return vi.spyOn(Client.prototype, 'request').mockImplementation((async (req: Record<string, unknown>) => {
    if (req.command === 'ledger') return { result: { ledger_index: 100 } }
    if (req.command === 'ledger_entry' && req.mpt_issuance) {
      return { result: { node: { Issuer: REGISTER, Flags: issuanceFlags, OutstandingAmount: deskUnits, MaximumAmount: '9223372036854775807' } } }
    }
    if (req.command === 'ledger_entry' && req.mptoken) {
      const { account } = req.mptoken as { account: string }
      if (account === DESK) return { result: { node: { Account: DESK, MPTAmount: deskUnits, Flags: 0 } } }
      throw new RippledError('Not found', { error: 'entryNotFound' })
    }
    throw new Error(`unexpected ${String(req.command)}`)
  }) as never)
}

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

describe('transfer readiness in plain copy', () => {
  it("says a destination without a holding can't hold units yet, and blocks", async () => {
    mockLedger('1000000000000')
    const notice = await checkTransfer(DESK, INVESTOR, ISSUANCE, { source: 'The Dealing Desk' })
    expect(notice).toEqual({
      blocked: true,
      label: "Can't hold units yet",
      lines: [
        "rUTE43…ceaQ hasn't set up a holding yet, so it can't receive units. It needs to connect and self-authorise on the fund overview first.",
      ],
    })
  })

  it('checks Desk inventory against the amount', async () => {
    mockLedger('1000000000')
    const notice = await checkTransfer(DESK, INVESTOR, ISSUANCE, { source: 'The Dealing Desk', amount: '2000000000' })
    expect(notice?.blocked).toBe(true)
    expect(notice?.lines).toContain('The Dealing Desk holds fewer units than this.')
  })

  it("names both possibilities for a lock when it doesn't know what's locked", () => {
    const check = { status: 'blocked' as const, message: 'The issuance or a holder is locked for this transfer.' }
    const notice = describeReadiness({ status: 'blocked', checks: [check] }, { destination: INVESTOR, source: 'The Dealing Desk' })
    expect(notice).toMatchObject({ blocked: true, label: 'Units are locked' })
    expect(notice?.lines[0]).toMatch(/dealing is suspended, or a stop-transfer is in place/)
    // The lock lifted between the check and the read: nothing specific to say.
    const lifted = describeReadiness(
      { status: 'blocked', checks: [check] },
      { destination: INVESTOR, source: 'The Dealing Desk', locks: { issuance: false, source: false, destination: false } },
    )
    expect(lifted?.label).toBe('Units are locked')
  })

  it("keeps an unknown result advisory and falls back to the SDK's words for unmapped checks", () => {
    const notice = describeReadiness(
      { status: 'unknown', checks: [{ status: 'pass', message: 'ok' }, { status: 'unknown', message: 'Something new.' }] },
      { destination: INVESTOR, source: 'Your account' },
    )
    expect(notice).toEqual({ blocked: false, label: 'Check the destination', lines: ['Something new.'] })
    expect(describeReadiness({ status: 'eligible', checks: [] }, { destination: INVESTOR, source: 'x' })).toBeNull()
  })
})

describe('Deliver units under RequireAuth', () => {
  /** Ledger flags lsfMPTRequireAuth | lsfMPTCanTransfer; holder flag lsfMPTAuthorized. */
  const REQUIRE_AUTH_ISSUANCE = 0x00000004 | LSF_MPT_CAN_TRANSFER
  const LSF_MPT_AUTHORIZED = 0x00000002
  const PENDING = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'

  /** lsfMPTLocked, on the issuance (dealing suspended) and on a holding (a stop-transfer) alike. */
  const LSF_MPT_LOCKED = 0x00000001

  /**
   * The Desk (admitted) holds `deskUnits`; the investor's MPToken has
   * `investorFlags`, or none. `failIssuanceReadAfter` makes every issuance
   * read after that many fail.
   */
  function mockRequireAuthLedger(
    deskUnits: string,
    investorFlags: number | undefined,
    opts: { issuanceFlags?: number; deskFlags?: number; failIssuanceReadAfter?: number } = {},
  ) {
    let issuanceReads = 0
    return vi.spyOn(Client.prototype, 'request').mockImplementation((async (req: Record<string, unknown>) => {
      if (req.command === 'ledger') return { result: { ledger_index: 100 } }
      if (req.command === 'ledger_entry' && req.mpt_issuance) {
        if (opts.failIssuanceReadAfter !== undefined && ++issuanceReads > opts.failIssuanceReadAfter) throw new Error('Offline')
        return { result: { node: { Issuer: REGISTER, Flags: opts.issuanceFlags ?? REQUIRE_AUTH_ISSUANCE, OutstandingAmount: deskUnits } } }
      }
      if (req.command === 'ledger_entry' && req.mptoken) {
        const { account } = req.mptoken as { account: string }
        if (account === DESK) return { result: { node: { Account: DESK, MPTAmount: deskUnits, Flags: opts.deskFlags ?? LSF_MPT_AUTHORIZED } } }
        if (account === PENDING && investorFlags !== undefined) return { result: { node: { Account: PENDING, MPTAmount: '0', Flags: investorFlags } } }
        throw new RippledError('Not found', { error: 'entryNotFound' })
      }
      throw new Error(`unexpected ${String(req.command)}`)
    }) as never)
  }

  it("blocks a pending destination as 'Not on the register', in the handoff's words", async () => {
    mockRequireAuthLedger('25000000', 0)
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', amount: '25000000', requireAuth: true })
    expect(notice).toEqual({
      blocked: true,
      label: 'Not on the register',
      lines: ["rwwCKT…dMVt hasn't been admitted yet, so it can't hold units. A Register keyholder needs to admit it first, from Admit investor."],
    })
  })

  it('lets an admitted destination through', async () => {
    mockRequireAuthLedger('25000000', LSF_MPT_AUTHORIZED)
    expect(await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', amount: '25000000', requireAuth: true })).toBeNull()
  })

  it('points a destination with no holding at the admission request', async () => {
    mockRequireAuthLedger('25000000', undefined)
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', requireAuth: true })
    expect(notice).toMatchObject({ blocked: true, label: 'Not on the register' })
    expect(notice?.lines[0]).toMatch(/hasn't requested admission yet/)
  })

  it('names a stop-transfer on the destination when the issuance itself is open', async () => {
    mockRequireAuthLedger('25000000', LSF_MPT_AUTHORIZED | LSF_MPT_LOCKED)
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', amount: '25000000', requireAuth: true })
    expect(notice).toEqual({
      blocked: true,
      label: 'Stop-transfer in place',
      lines: ["rwwCKT…dMVt has a stop-transfer in place, so it can't receive units until the Register releases it."],
    })
  })

  it("names a stop-transfer on the sender's holding", async () => {
    mockRequireAuthLedger('25000000', LSF_MPT_AUTHORIZED, { deskFlags: LSF_MPT_AUTHORIZED | LSF_MPT_LOCKED })
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', requireAuth: true })
    expect(notice).toEqual({
      blocked: true,
      label: 'Stop-transfer in place',
      lines: ["The Dealing Desk has a stop-transfer in place, so it can't send units until the Register releases it."],
    })
  })

  it('names a suspended class first, and a stop-transfer alongside it', async () => {
    mockRequireAuthLedger('25000000', LSF_MPT_AUTHORIZED | LSF_MPT_LOCKED, { issuanceFlags: REQUIRE_AUTH_ISSUANCE | LSF_MPT_LOCKED })
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', requireAuth: true })
    expect(notice).toEqual({
      blocked: true,
      label: 'Dealing suspended',
      lines: [
        "The Register has suspended dealing for the class. Units can't move until it lifts the suspension. rwwCKT…dMVt has a stop-transfer in place, so it can't receive units until the Register releases it.",
      ],
    })
  })

  it("keeps the general lock line when the lock read fails, and doesn't turn it into an error", async () => {
    mockRequireAuthLedger('25000000', LSF_MPT_AUTHORIZED | LSF_MPT_LOCKED, { failIssuanceReadAfter: 1 })
    const notice = await checkTransfer(DESK, PENDING, ISSUANCE, { source: 'The Dealing Desk', requireAuth: true })
    expect(notice).toMatchObject({ blocked: true, label: 'Units are locked' })
    expect(notice?.lines[0]).toMatch(/dealing is suspended, or a stop-transfer is in place/)
  })
})
