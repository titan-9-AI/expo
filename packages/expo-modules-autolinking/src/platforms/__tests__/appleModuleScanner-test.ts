import spawnAsync from '@expo/spawn-async';

import {
  groupScannedModules,
  scanExpoModulesAsync,
  type ScannerPluginInfo,
  type ScanModulesOutput,
} from '../apple/moduleScanner';

jest.mock('@expo/spawn-async');

const mockSpawnAsync = spawnAsync as jest.MockedFunction<typeof spawnAsync>;

const pluginInfo: ScannerPluginInfo = {
  binaryPath: '/app/node_modules/@expo/expo-modules-macros-plugin/apple/ExpoModulesMacros-tool',
  version: '0.9.0',
};

const packageRoots: Record<string, string> = {
  'expo-clipboard': '/app/node_modules/expo-clipboard',
  'expo-camera': '/app/node_modules/expo-camera',
};

function scannerOutput(partial: Partial<ScanModulesOutput>): ScanModulesOutput {
  return {
    schemaVersion: 1,
    modules: [],
    warnings: [],
    stats: { filesScanned: 0, filesParsed: 0, durationMs: 0 },
    ...partial,
  };
}

function mockScannerResult(output: ScanModulesOutput) {
  mockSpawnAsync.mockResolvedValueOnce({
    stdout: JSON.stringify(output),
  } as any);
}

describe(scanExpoModulesAsync, () => {
  it('invokes the scanner binary with every package root', async () => {
    mockScannerResult(scannerOutput({}));

    await scanExpoModulesAsync(pluginInfo, packageRoots);

    expect(mockSpawnAsync).toHaveBeenCalledWith(
      pluginInfo.binaryPath,
      ['scan-modules', '/app/node_modules/expo-clipboard', '/app/node_modules/expo-camera'],
      expect.anything()
    );
  });

  it('parses the scanner JSON output', async () => {
    mockScannerResult(
      scannerOutput({
        modules: [
          {
            name: 'ClipboardModule',
            jsName: 'Clipboard',
            accessLevel: 'public',
            file: '/app/node_modules/expo-clipboard/ios/ClipboardModule.swift',
          },
        ],
      })
    );

    const output = await scanExpoModulesAsync(pluginInfo, packageRoots);

    expect(output?.modules).toHaveLength(1);
    expect(output?.modules[0]?.name).toBe('ClipboardModule');
  });

  it('returns null and warns when the schema version is unsupported', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    mockScannerResult(scannerOutput({ schemaVersion: 999 }));

    expect(await scanExpoModulesAsync(pluginInfo, packageRoots)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema version'));
  });

  it('returns null and warns when the scanner fails to run', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    mockSpawnAsync.mockRejectedValueOnce(new Error('spawn failure'));

    expect(await scanExpoModulesAsync(pluginInfo, packageRoots)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn failure'));
  });

  it('returns null without scanning when there are no package roots', async () => {
    expect(await scanExpoModulesAsync(pluginInfo, {})).toBeNull();
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it('prints the scanner warnings with their locations', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    mockScannerResult(
      scannerOutput({
        warnings: [
          {
            message: "cannot evaluate 'canImport(SomeSDK)' in a static scan",
            file: '/app/node_modules/expo-camera/ios/CameraModule.swift',
            line: 3,
          },
        ],
      })
    );

    await scanExpoModulesAsync(pluginInfo, packageRoots);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/CameraModule\.swift:3.+canImport\(SomeSDK\)/)
    );
  });
});

describe(groupScannedModules, () => {
  it('assigns each module to the package whose root contains its file', () => {
    const output = scannerOutput({
      modules: [
        {
          name: 'ClipboardModule',
          jsName: 'Clipboard',
          accessLevel: 'public',
          file: '/app/node_modules/expo-clipboard/ios/ClipboardModule.swift',
        },
        {
          name: 'CameraModule',
          jsName: 'CameraModule',
          accessLevel: 'open',
          file: '/app/node_modules/expo-camera/ios/CameraModule.swift',
        },
      ],
    });

    const grouped = groupScannedModules(output, packageRoots);

    expect(grouped).toEqual({
      'expo-clipboard': [{ name: 'Clipboard', class: 'ClipboardModule' }],
      'expo-camera': [{ name: 'CameraModule', class: 'CameraModule' }],
    });
  });

  it('excludes classes that are not public or open, with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const output = scannerOutput({
      modules: [
        {
          name: 'InternalModule',
          jsName: 'InternalModule',
          accessLevel: 'internal',
          file: '/app/node_modules/expo-clipboard/ios/InternalModule.swift',
        },
        {
          name: 'PrivateModule',
          jsName: 'PrivateModule',
          accessLevel: 'private',
          file: '/app/node_modules/expo-clipboard/ios/Tests/PrivateModule.swift',
        },
      ],
    });

    const grouped = groupScannedModules(output, packageRoots);

    expect(grouped).toEqual({});
    // The internal (default) access level is likely unintentional, so it warns; the explicitly
    // spelled private one is a deliberate opt-out (e.g. a test fixture) and stays quiet.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/InternalModule.+public/));
  });

  it('ignores modules outside of every package root', () => {
    const output = scannerOutput({
      modules: [
        {
          name: 'StrayModule',
          jsName: 'StrayModule',
          accessLevel: 'public',
          file: '/somewhere/else/StrayModule.swift',
        },
      ],
    });

    expect(groupScannedModules(output, packageRoots)).toEqual({});
  });

  it('prefers the longest matching root for nested package paths', () => {
    const nestedRoots = {
      'expo-camera': '/app/node_modules/expo-camera',
      'expo-camera-next': '/app/node_modules/expo-camera/next',
    };
    const output = scannerOutput({
      modules: [
        {
          name: 'NextCameraModule',
          jsName: 'NextCameraModule',
          accessLevel: 'public',
          file: '/app/node_modules/expo-camera/next/ios/NextCameraModule.swift',
        },
      ],
    });

    const grouped = groupScannedModules(output, nestedRoots);

    expect(grouped).toEqual({
      'expo-camera-next': [{ name: 'NextCameraModule', class: 'NextCameraModule' }],
    });
  });
});
