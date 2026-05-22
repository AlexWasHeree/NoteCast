/** Narrow callback interface used by NoteProcessor to signal that a note
 *  has finished processing, without depending on a concrete application-layer class. */
export interface INoteProcessedCallback {
  onNoteProcessed(): Promise<void>;
}
