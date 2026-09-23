import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, Wallet, encodeMemo } from 'xrpl'
const client = new Client('ws://localhost:6006')
const source = Wallet.generate().address
const destination = Wallet.generate().address

describe('SDK memo encoding (browser compatibility)', () => {
  const originalBuffer = globalThis.Buffer

  beforeEach(() => {
    // The SDK memo helper is used in the browser bundle under `web/`,
    // where Node's `Buffer` global does not exist. Deleting it here
    // reproduces that environment exactly, so a future edit that
    // reintroduces a `Buffer` dependency fails this test instead of only
    // failing silently in a real browser (as it did before this was caught).
    // @ts-expect-error -- deliberately removing a Node global for the test
    delete globalThis.Buffer
  })

  afterEach(() => {
    globalThis.Buffer = originalBuffer
  })

  it('encodes a memo without referencing the Node Buffer global', () => {
    const tx = client
      .forAccount(source)
      .tx.payment({
        Destination: destination,
        Amount: { mpt_issuance_id: '0'.repeat(48), value: '100' },
        Memos: [encodeMemo({ type: 'mint-period', data: '2027' })],
      })
      .toJSON()

    expect(tx.Memos).toEqual([
      {
        Memo: {
          MemoType: '6D696E742D706572696F64', // 'mint-period'
          MemoData: '32303237', // '2027'
        },
      },
    ])
  })

  it('omits Memos entirely when no memo is given', () => {
    const tx = client.forAccount(source).tx.payment({ Destination: destination, Amount: '100' }).toJSON()
    expect(tx.Memos).toBeUndefined()
  })
})
