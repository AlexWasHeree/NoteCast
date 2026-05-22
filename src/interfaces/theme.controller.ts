import type {
  AssignNoteToThemeUseCase,
  CreateThemeUseCase,
  DeleteThemeUseCase,
  ListThemesUseCase,
  MergeThemesUseCase,
  RemoveNoteFromThemeUseCase,
  UpdateThemeUseCase,
} from '../application/themes/theme.usecase';
import type { Theme } from '../domain/theme/theme.entity';

/** Strip internal embedding fields before sending to API consumers. */
export function toPublicTheme(theme: Theme): Omit<Theme, 'descriptionVector'> {
  const { descriptionVector: _v, ...rest } = theme;
  return rest;
}

export class ThemeController {
  constructor(
    private createThemeUseCase: CreateThemeUseCase,
    private deleteThemeUseCase: DeleteThemeUseCase,
    private listThemesUseCase: ListThemesUseCase,
    private updateThemeUseCase: UpdateThemeUseCase,
    private assignNoteUseCase: AssignNoteToThemeUseCase,
    private removeNoteUseCase: RemoveNoteFromThemeUseCase,
    private mergeThemesUseCase: MergeThemesUseCase,
  ) {}

  async list() {
    try {
      const themes = await this.listThemesUseCase.execute();
      return Response.json(themes.map(toPublicTheme));
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async create(req: Request) {
    try {
      const body = (await req.json()) as {
        name?: string;
        parentId?: string;
        description?: string;
      };
      if (!body.name) {
        return Response.json({ error: 'Missing name' }, { status: 400 });
      }
      const theme = await this.createThemeUseCase.execute({
        name: body.name,
        parentId: body.parentId,
        description: body.description,
      });
      return Response.json(toPublicTheme(theme), { status: 201 });
    } catch (err: any) {
      if (err.message.startsWith('Theme already exists')) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      if (err.message.startsWith('Parent theme not found')) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async delete(id: string) {
    try {
      await this.deleteThemeUseCase.execute(id);
      return new Response(null, { status: 204 });
    } catch (err: any) {
      if (err.message.startsWith('Theme not found')) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async update(id: string, req: Request) {
    try {
      const body = (await req.json()) as {
        name?: string;
        description?: string;
        parentIds?: string[];
      };
      if (
        body.name === undefined &&
        body.description === undefined &&
        body.parentIds === undefined
      ) {
        return Response.json(
          { error: 'Provide at least one of: name, description, parentIds' },
          { status: 400 },
        );
      }
      const theme = await this.updateThemeUseCase.execute(id, body);
      return Response.json(toPublicTheme(theme));
    } catch (err: any) {
      if (err.message.startsWith('Theme not found')) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      if (
        err.message.startsWith('Theme already exists') ||
        err.message.startsWith('Parent theme not found') ||
        err.message.startsWith('cycle')
      ) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async assignNote(themeId: string, noteId: string) {
    try {
      await this.assignNoteUseCase.execute(noteId, themeId);
      return new Response(null, { status: 204 });
    } catch (err: any) {
      if (err.message.startsWith('Note not found') || err.message.startsWith('Theme not found')) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async unassignNote(themeId: string, noteId: string) {
    try {
      await this.removeNoteUseCase.execute(noteId, themeId);
      return new Response(null, { status: 204 });
    } catch (err: any) {
      if (err.message.startsWith('Note not found') || err.message.startsWith('Theme not found')) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  async merge(req: Request) {
    try {
      const body = (await req.json()) as { sourceId?: string; targetId?: string };
      if (!body.sourceId || !body.targetId) {
        return Response.json({ error: 'Missing sourceId or targetId' }, { status: 400 });
      }
      const result = await this.mergeThemesUseCase.execute(body.sourceId, body.targetId);
      return Response.json(result);
    } catch (err: any) {
      if (
        err.message.startsWith('Source theme not found') ||
        err.message.startsWith('Target theme not found')
      ) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      if (err.message.includes('same')) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
}
