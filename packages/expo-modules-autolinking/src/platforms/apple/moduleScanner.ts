import spawnAsync from '@expo/spawn-async';
import fs from 'fs';
import path from 'path';

import type { ModuleIosConfig } from '../../types';

/**
 * The scan output schema this consumer understands. When the scanner reports a different version,
 * its output is not trusted and autolinking falls back to config-declared modules.
 */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * The prebuilt binary inside `@expo/expo-modules-macros-plugin` that runs the scanner CLI.
 * The same executable serves as the Swift compiler's macro plugin; with arguments it dispatches
 * to the scanner instead of the plugin server.
 */
const SCANNER_BINARY_RELATIVE_PATH = 'apple/ExpoModulesMacros-tool';

export interface ScannerPluginInfo {
  binaryPath: string;
  version: string;
}

interface ScannedModule {
  /** The Swift class name the module is declared as. */
  name: string;
  /** The resolved JS module name: the `@ExpoModule("Foo")` override, or the class name. */
  jsName: string;
  /** The spelled access modifier, or `internal` when none is written. */
  accessLevel: string;
  /** Absolute path of the source file the module was found in. */
  file: string;
}

interface ScanWarning {
  message: string;
  file: string;
  line: number;
}

export interface ScanModulesOutput {
  schemaVersion: number;
  modules: ScannedModule[];
  warnings: ScanWarning[];
  stats: { filesScanned: number; filesParsed: number; durationMs: number };
}

/**
 * Resolves the macros plugin package (from the given resolution base, usually the installed
 * `expo-modules-core` directory, which depends on it) and returns the scanner binary path and the
 * plugin version. Returns null when the package is not installed, or is too old to ship a binary
 * that understands scanner subcommands.
 */
export function resolveScannerPlugin(resolutionBasePath: string): ScannerPluginInfo | null {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('@expo/expo-modules-macros-plugin/package.json', {
      paths: [resolutionBasePath],
    });
  } catch {
    return null;
  }
  const binaryPath = path.join(path.dirname(packageJsonPath), SCANNER_BINARY_RELATIVE_PATH);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }
  const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  // Versions below 0.9.0 ship the binary without the scanner CLI. Running one of those with
  // arguments would start the compiler plugin server, which blocks reading the plugin protocol
  // from stdin instead of scanning.
  if (typeof version !== 'string' || !satisfiesMinimumVersion(version, [0, 9, 0])) {
    return null;
  }
  return { binaryPath, version };
}

function satisfiesMinimumVersion(version: string, minimum: number[]): boolean {
  const components = version.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    const component = components[i] ?? 0;
    const minimumComponent = minimum[i]!;
    if (Number.isNaN(component)) {
      return false;
    }
    if (component !== minimumComponent) {
      return component > minimumComponent;
    }
  }
  return true;
}

/**
 * Runs the scanner once over all package roots and returns the parsed output. The scan runs without
 * a platform, so it reports the unconditional `@ExpoModule` classes; a module inside a conditional
 * compilation block it cannot resolve is skipped and lands in `warnings`, which are printed with
 * their source locations. Returns null, after printing a warning, when the scanner fails or reports
 * an unsupported schema version, so the caller falls back to config-declared modules.
 */
export async function scanExpoModulesAsync(
  pluginInfo: ScannerPluginInfo,
  packageRoots: Record<string, string>
): Promise<ScanModulesOutput | null> {
  const roots = Object.values(packageRoots);
  if (!roots.length) {
    return null;
  }

  let output: ScanModulesOutput;
  try {
    const result = await spawnAsync(pluginInfo.binaryPath, ['scan-modules', ...roots], {
      stdio: 'pipe',
    });
    output = JSON.parse(result.stdout);
  } catch (error: any) {
    console.warn(
      `⚠️  Scanning for Expo modules failed, only modules declared in expo-module.config.json will be linked: ${error.message ?? error}`
    );
    return null;
  }

  if (output.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    console.warn(
      `⚠️  The Expo modules scanner reported schema version ${output.schemaVersion}, but this version of expo-modules-autolinking understands ${SUPPORTED_SCHEMA_VERSION}. Update expo-modules-autolinking, or align the @expo/expo-modules-macros-plugin version; only modules declared in expo-module.config.json will be linked.`
    );
    return null;
  }

  for (const warning of output.warnings) {
    console.warn(`⚠️  ${warning.file}:${warning.line}: ${warning.message}`);
  }
  return output;
}

/**
 * Groups the scanned modules by the package owning their source file (the package with the longest
 * root path containing it) and maps them to the module config shape used by the modules provider.
 * Classes that aren't `public` or `open` can't be referenced by the generated provider, so they're
 * excluded: with a warning for the (likely unintentional) default `internal`, silently for an
 * explicitly spelled lower access level, which reads as a deliberate opt-out (e.g. a test fixture).
 */
export function groupScannedModules(
  output: ScanModulesOutput,
  packageRoots: Record<string, string>
): Record<string, ModuleIosConfig[]> {
  const rootEntries = Object.entries(packageRoots).sort(
    ([, rootA], [, rootB]) => rootB.length - rootA.length
  );
  const grouped: Record<string, ModuleIosConfig[]> = {};

  for (const module of output.modules) {
    if (module.accessLevel !== 'public' && module.accessLevel !== 'open') {
      if (module.accessLevel === 'internal') {
        console.warn(
          `⚠️  The @ExpoModule class '${module.name}' (${module.file}) has no access modifier, so it defaults to internal and cannot be linked automatically. Declare it public, or spell a lower access level to silence this warning.`
        );
      }
      continue;
    }
    const owner = rootEntries.find(([, root]) => module.file.startsWith(root + path.sep));
    if (!owner) {
      continue;
    }
    (grouped[owner[0]] ??= []).push({ name: module.jsName, class: module.name });
  }
  return grouped;
}
