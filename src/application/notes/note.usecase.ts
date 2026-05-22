import type { INoteRepository, Note } from '../../domain/note/note.entity';
import type { IThemeRepository } from '../../domain/theme/theme.entity';
import { newId } from '../../infrastructure/id';

export interface IQueueProvider {
  enqueue(noteId: string): Promise<void>;
}

export class CreateNoteUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private queueProvider: IQueueProvider,
  ) {}

  async execute(title: string, content: string, sourceFile?: string): Promise<Note> {
    const note: Note = {
      id: newId(),
      title,
      content,
      status: 'pending',
      createdAt: new Date(),
      summary: '',
      topics: [],
      contentVector: [],
      summaryVector: [],
      relatedNoteIds: [],
      sourceFile,
    };

    await this.noteRepository.save(note);
    await this.queueProvider.enqueue(note.id);

    return note;
  }
}

export class GetNoteUseCase {
  constructor(private noteRepository: INoteRepository) {}

  async execute(id: string): Promise<Note | null> {
    return this.noteRepository.findById(id);
  }
}

export class ListNotesUseCase {
  constructor(private noteRepository: INoteRepository) {}

  async execute(): Promise<Note[]> {
    return this.noteRepository.findAll();
  }
}

export interface CreateNoteInput {
  title: string;
  content: string;
}

export class CreateNotesBatchUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private queueProvider: IQueueProvider,
  ) {}

  async execute(notes: CreateNoteInput[]): Promise<Note[]> {
    const created: Note[] = [];

    for (const { title, content } of notes) {
      const note: Note = {
        id: newId(),
        title,
        content,
        status: 'pending',
        createdAt: new Date(),
        summary: '',
        topics: [],
        contentVector: [],
        summaryVector: [],
        relatedNoteIds: [],
      };

      await this.noteRepository.save(note);
      await this.queueProvider.enqueue(note.id);
      created.push(note);
    }

    return created;
  }
}

export class DeleteNoteUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
  ) {}

  async execute(id: string): Promise<boolean> {
    const note = await this.noteRepository.findById(id);
    if (!note) return false;

    for (const themeId of note.themeIds ?? []) {
      const theme = await this.themeRepository.findById(themeId);
      if (!theme) continue;
      await this.themeRepository.update({
        ...theme,
        noteIds: theme.noteIds.filter((nid) => nid !== id),
      });
    }

    await this.noteRepository.delete(id);
    return true;
  }
}

export class EditNoteUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private themeRepository: IThemeRepository,
    private queueProvider: IQueueProvider,
  ) {}

  async execute(id: string, fields: { title?: string; content?: string }): Promise<Note | null> {
    const note = await this.noteRepository.findById(id);
    if (!note) return null;

    const titleChanged = fields.title !== undefined && fields.title !== note.title;
    const contentChanged = fields.content !== undefined && fields.content !== note.content;
    const shouldRegress =
      (titleChanged || contentChanged) &&
      (note.status === 'scanned' || note.status === 'organized');

    if (shouldRegress) {
      for (const themeId of note.themeIds ?? []) {
        const theme = await this.themeRepository.findById(themeId);
        if (!theme) continue;
        await this.themeRepository.update({
          ...theme,
          noteIds: theme.noteIds.filter((nid) => nid !== note.id),
        });
      }
      const updated: Note = {
        ...note,
        title: fields.title ?? note.title,
        content: fields.content ?? note.content,
        status: 'pending',
        summary: '',
        topics: [],
        contentVector: [],
        summaryVector: [],
        themeIds: [],
        relatedNoteIds: [],
      };
      await this.noteRepository.update(updated);
      await this.queueProvider.enqueue(note.id);
      return updated;
    }

    const updated: Note = {
      ...note,
      title: fields.title ?? note.title,
      content: fields.content ?? note.content,
    };
    await this.noteRepository.update(updated);
    return updated;
  }
}

export class RetryFailedNotesUseCase {
  constructor(
    private noteRepository: INoteRepository,
    private queueProvider: IQueueProvider,
  ) {}

  async execute(): Promise<{ retried: number }> {
    const failed = await this.noteRepository.findByStatus('failed');
    for (const note of failed) {
      const { failureReason: _dropped, ...rest } = note;
      const reset: Note = {
        ...rest,
        status: 'pending',
        summary: '',
        topics: [],
        contentVector: [],
        summaryVector: [],
        relatedNoteIds: [],
      };
      await this.noteRepository.update(reset);
      await this.queueProvider.enqueue(note.id);
    }
    return { retried: failed.length };
  }
}
