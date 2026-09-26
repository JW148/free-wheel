import { describe, expect, it } from 'vitest'
import { clearUndoStack } from './undoStack'

describe('clearUndoStack', () => {
  it('attaches an iframe and detaches it again, which is what makes WebKit clear the stack', () => {
    const events: string[] = []
    const frame = {
      style: {} as Record<string, string>,
      tabIndex: 0,
      setAttribute: () => {},
      remove: () => events.push('detached'),
    }
    const doc = {
      createElement: (tag: string) => {
        events.push(`created ${tag}`)
        return frame
      },
      body: { appendChild: () => events.push('attached') },
    } as unknown as Document

    clearUndoStack(doc)

    expect(events).toEqual(['created iframe', 'attached', 'detached'])
    expect(frame.style.display).toBe('none')
  })
})
