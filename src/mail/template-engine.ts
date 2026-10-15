import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

export type TemplateContext = Record<string, unknown>;

@Injectable()
export class EmailTemplateEngine {
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();

  constructor(
    private readonly templateDirs: readonly string[],
    private readonly frontendUrl = 'http://localhost:3000',
  ) {
    this.registerHelpers();
  }

  render(name: string, context: TemplateContext = {}): string {
    const templatePath = this.resolveTemplatePath(name);
    const renderContext = { ...context } as TemplateContext & { __layout?: string };
    const body = this.compile(templatePath)(renderContext);

    if (!renderContext.__layout) return body;
    return this.compile(this.resolveTemplatePath(renderContext.__layout))({
      ...context,
      body,
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  private compile(filePath: string): Handlebars.TemplateDelegate {
    const cached = this.cache.get(filePath);
    if (cached) return cached;

    const compiled = Handlebars.compile(readFileSync(filePath, 'utf8'));
    this.cache.set(filePath, compiled);
    return compiled;
  }

  private resolveTemplatePath(name: string): string {
    if (!name.endsWith('.hbs') || isAbsolute(name)) {
      throw new Error(`Invalid email template: ${name}`);
    }

    const matches = this.templateDirs
      .map((directory) => {
        const root = resolve(directory);
        const candidate = resolve(root, normalize(name));
        const pathFromRoot = relative(root, candidate);
        return pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)
          ? null
          : candidate;
      })
      .filter((candidate): candidate is string =>
        candidate !== null && existsSync(candidate),
      );

    if (!matches.length) throw new Error(`Email template not found: ${name}`);
    if (matches.length > 1) throw new Error(`Email template is ambiguous: ${name}`);
    return matches[0];
  }

  private registerHelpers(): void {
    Handlebars.registerHelper(
      'layout',
      function (this: TemplateContext & { __layout?: string }, layout: string) {
        this.__layout = layout;
        return '';
      },
    );
    Handlebars.registerHelper('url', (path: string) => {
      const baseUrl = this.frontendUrl.replace(/\/$/, '');
      return new Handlebars.SafeString(
        `${baseUrl}/${String(path).replace(/^\//, '')}`,
      );
    });
    Handlebars.registerHelper('concat', (...args: unknown[]) =>
      args.slice(0, -1).map(String).join(''),
    );
  }
}
