/**
 * Empties WebKit's undo stack for the whole page, so iOS has nothing to offer on a shake.
 *
 * ## Why this exists
 *
 * iOS shows "Undo Typing" whenever the web view's undo manager has an action on it, and a bike
 * on rough ground shakes the phone continuously. Removing the text field does not remove its
 * typing: WebKit keeps each edit on the page-wide stack after the element has gone. So a rider
 * who typed a destination into the search screen and then pressed Start got the alert every few
 * seconds, even though the riding screen has no text field of its own.
 *
 * ## Why an iframe
 *
 * A page has no API for this. The one path WebKit takes is `FrameLoader::closeURL()`, which runs
 * `Editor::clearUndoRedoOperations()` → `WebEditorClient::clearUndoRedoOperations()` →
 * `ClearAllEditCommands`, and on iOS that is `removeAllActionsWithTarget:` on the content view's
 * undo manager. The client belongs to the page, not the frame, so any frame closing clears every
 * frame's edits. `detachFromParent()` calls `closeURL()`, which means inserting an empty iframe
 * and removing it again is enough: it gets an initial `about:blank` document synchronously, and
 * detaching it closes that document.
 *
 * Harmless everywhere else: in a browser without this behaviour it is an iframe that exists for
 * one statement.
 */
export function clearUndoStack(doc: Pick<Document, 'createElement' | 'body'> = document): void {
  const frame = doc.createElement('iframe')
  frame.style.display = 'none'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  doc.body.appendChild(frame)
  frame.remove()
}
