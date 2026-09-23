import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'xrpl'
import { getProposalStatus } from '../../src/lib/xrplClient'
import { isProblem, problemCopy } from '../../src/lib/outcome'

const ISSUANCE = '013FF064D26B0039BF8C5440F2F6A96AD315F996B25EF837'
const DESK = 'rB6b46dDoxhJtnJ52w5BtErYBazapCpCAD'
const INVESTOR = 'rUTE43GKdqLK3RkyBmKdczRdQFDSWCceaQ'
const OTHER = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'

const proposal = {
  TransactionType: 'Payment',
  Account: DESK,
  Destination: INVESTOR,
  Amount: { mpt_issuance_id: ISSUANCE, value: '25000000000000' },
  Sequence: 50,
}

/** An account_tx API v1 row: `{ meta, tx, validated }`. */
function row(tx: Record<string, unknown>, result = 'tesSUCCESS') {
  return { meta: { TransactionResult: result }, tx: { hash: `H${String(tx.Sequence)}`, ledger_index: 100, ...tx }, validated: true }
}

function mockLedger(accountSequence: number, pages: unknown[][]) {
  let page = 0
  return vi.spyOn(Client.prototype, 'request').mockImplementation((async (req: { command: string }) => {
    if (req.command === 'account_info') return { result: { account_data: { Account: DESK, Sequence: accountSequence } } }
    if (req.command === 'account_tx') {
      const transactions = pages[page] ?? []
      page += 1
      return { result: { transactions, marker: page < pages.length ? { page } : undefined } }
    }
    throw new Error(`unexpected ${req.command}`)
  }) as never)
}

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

describe('proposal status', () => {
  it('is pending while the account sequence has not moved past it', async () => {
    mockLedger(50, [])
    expect(await getProposalStatus(proposal)).toEqual({ status: 'pending' })
  })

  it('is done when this proposal landed and succeeded', async () => {
    mockLedger(51, [[row({ ...proposal })]])
    expect(await getProposalStatus(proposal)).toEqual({ status: 'done', hash: 'H50' })
  })

  it('is failed, with the result code, when this proposal landed with a tec result', async () => {
    mockLedger(51, [[row({ ...proposal }, 'tecLOCKED')]])
    const status = await getProposalStatus(proposal)
    expect(status).toEqual({ status: 'failed', result: 'tecLOCKED', hash: 'H50' })
    expect(isProblem(status)).toBe(true)
    if (status.status === 'failed') {
      const copy = problemCopy(status)
      expect(copy.label).toBe('Failed on the ledger')
      expect(copy.headline).toBe('The XRPL testnet rejected it (tecLOCKED). No units moved.')
      expect(copy.detail).toMatch(/dealing is suspended, or a stop-transfer is in place/)
    }
  })

  it('is superseded only when a different transaction used the sequence', async () => {
    mockLedger(51, [[row({ ...proposal, Destination: OTHER }, 'tecNO_AUTH')]])
    expect(await getProposalStatus(proposal)).toEqual({ status: 'superseded', hash: 'H50' })
    vi.restoreAllMocks()
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    mockLedger(51, [[row({ TransactionType: 'AccountSet', Account: DESK, Sequence: 50 })]])
    expect((await getProposalStatus(proposal)).status).toBe('superseded')
  })

  it('skips incoming rows and later sequences, reads further pages, and stops once past the sequence', async () => {
    const request = mockLedger(53, [
      [row({ TransactionType: 'Payment', Account: OTHER, Destination: DESK, Sequence: 50 }), row({ ...proposal, Sequence: 52 })],
      [row({ ...proposal, Sequence: 51 }), row({ ...proposal }, 'tecINSUFFICIENT_FUNDS')],
    ])
    expect(await getProposalStatus(proposal)).toMatchObject({ status: 'failed', result: 'tecINSUFFICIENT_FUNDS' })
    expect(request.mock.calls.filter(([req]) => (req as { command: string }).command === 'account_tx')).toHaveLength(2)

    vi.restoreAllMocks()
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
    mockLedger(53, [[row({ ...proposal, Sequence: 52 }), row({ ...proposal, Sequence: 49 })], [row({ ...proposal })]])
    expect(await getProposalStatus(proposal)).toEqual({ status: 'unknown' })
  })
})
