import type {
  CreateNotesBatchUseCase,
  CreateNoteUseCase,
  DeleteNoteUseCase,
  EditNoteUseCase,
  GetNoteUseCase,
  ListNotesUseCase,
  RetryFailedNotesUseCase,
} from '../application/notes/note.usecase';
import type { Note } from '../domain/note/note.entity';

/** Strip internal embedding fields before sending to API consumers. */
export function toPublicNote(note: Note): Omit<Note, 'contentVector' | 'summaryVector'> {
  const { contentVector: _v, summaryVector: _g, ...rest } = note;
  return rest;
}

export class NoteController {
  private vaultSync?: () => Promise<void>;

  constructor(
    private createNoteUseCase: CreateNoteUseCase,
    private createNotesBatchUseCase: CreateNotesBatchUseCase,
    private getNoteUseCase: GetNoteUseCase,
    private listNotesUseCase: ListNotesUseCase,
    private editNoteUseCase: EditNoteUseCase,
    private deleteNoteUseCase: DeleteNoteUseCase,
    private retryFailedNotesUseCase: RetryFailedNotesUseCase,
  ) {}

  setVaultSync(fn: () => Promise<void>): void {
    this.vaultSync = fn;
  }

  async create(req: Request) {
    try {
      const body = await req.json();
      const { title, content } = body as { title: string; content: string };
      if (!title || !content) {
        return Response.json({ error: 'Missing title or content' }, { status: 400 });
      }

      const note = await this.createNoteUseCase.execute(title, content);
      this.vaultSync?.().catch(() => {});
      return Response.json(toPublicNote(note), { status: 201 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async createBatch(req: Request) {
    try {
      const body = await req.json();
      const notes = body as Array<{ title: string; content: string }>;
      if (!Array.isArray(notes) || notes.length === 0) {
        return Response.json(
          { error: 'Expected non-empty array of { title, content }' },
          { status: 400 },
        );
      }

      const invalid = notes.find((n) => !n?.title || !n?.content);
      if (invalid) {
        return Response.json({ error: 'Each note must have title and content' }, { status: 400 });
      }

      const created = await this.createNotesBatchUseCase.execute(notes);
      this.vaultSync?.().catch(() => {});
      return Response.json(created.map(toPublicNote), { status: 201 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async list() {
    try {
      const notes = await this.listNotesUseCase.execute();
      return Response.json(notes.map(toPublicNote));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  async get(id: string) {
    try {
      const note = await this.getNoteUseCase.execute(id);

      if (!note) {
        return Response.json({ error: 'Note not found' }, { status: 404 });
      }

      return Response.json(toPublicNote(note));
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async edit(id: string, req: Request) {
    try {
      const body = (await req.json()) as { title?: string; content?: string };
      if (body.title === undefined && body.content === undefined) {
        return Response.json({ error: 'Provide title or content to update' }, { status: 400 });
      }
      const note = await this.editNoteUseCase.execute(id, body);
      if (!note) {
        return Response.json({ error: 'Note not found' }, { status: 404 });
      }
      return Response.json(toPublicNote(note));
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async delete(id: string) {
    try {
      const deleted = await this.deleteNoteUseCase.execute(id);
      if (!deleted) {
        return Response.json({ error: 'Note not found' }, { status: 404 });
      }
      return new Response(null, { status: 204 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async retryFailed() {
    try {
      const result = await this.retryFailedNotesUseCase.execute();
      return Response.json(result);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
}
