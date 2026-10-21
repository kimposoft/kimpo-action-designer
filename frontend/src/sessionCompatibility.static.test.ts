import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (!/\.(ts|vue)$/.test(entry.name) || /\.(test|spec)\.ts$/.test(entry.name)) return [];
    return [readFileSync(path, 'utf8')];
  });
}

describe('action-designer session hard-cut ratchet', () => {
  it('manifest 同时声明标准 capability、前端代际与四语言资源', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), '..', 'manifest.json'), 'utf8'));
    const surface = manifest.capabilities.frontend.surfaces.find((item: { type: string }) => item.type === 'action-designer');

    expect(surface.host_caps).toContain('platform.interactiveSession');
    expect(manifest.schema_compatibility['frontend.interactive-session']).toEqual({ min_version: 1 });
    expect(manifest.i18n.locales).toEqual(['zh-CN', 'en-US', 'ja-JP', 'zh-TW']);
  });

  it('production 入口强制 handle，且旧锁、裸 proof 与插件可见传输凭据零命中', () => {
    const sources = productionSources(join(process.cwd(), 'src')).join('\n');
    const surface = readFileSync(join(process.cwd(), 'src', 'surfaces', 'index.ts'), 'utf8');
    const root = readFileSync(join(process.cwd(), 'src', 'DesignerRoot.vue'), 'utf8');
    const designer = readFileSync(join(process.cwd(), 'src', 'designer', 'ActionDesigner.vue'), 'utf8');
    const nodeConfig = readFileSync(join(process.cwd(), 'src', 'designer', 'NodeConfigDialog.vue'), 'utf8');

    expect(surface).toContain('宿主未注入 platform.interactiveSession');
    expect(surface).toContain("from '@kimposoft/plugin-sdk/surface'");
    expect(surface).not.toMatch(/import\s*\{[^}]*definePluginSurface[^}]*\}\s*from\s*['\"]@kimposoft\/plugin-sdk['\"]/s);
    expect(root).toContain('interactiveSession: InteractiveSessionHandle;');
    expect(root).toContain('requestClose: () => Promise<boolean>;');
    expect(root).not.toContain("props.interactiveSession.close('user')");
    expect(designer).toContain('interactiveSession: InteractiveSessionHandle;');
    expect(designer).toContain('canCommitAuthority: () => props.sessionEditable');
    expect(nodeConfig).toContain('interactiveSession: InteractiveSessionHandle;');
    expect(sources).not.toMatch(
      /X-Kimpo-(?:Route|Attach)-Token|\/design-lock|\/edit-lease|\b(?:design_lock|edit_lease)\b|\b(?:acquire|renew|release)DesignLock\b|\b(?:routeToken|attachToken)\b/
    );
  });
});
