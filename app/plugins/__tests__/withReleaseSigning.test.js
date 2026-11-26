const { applyReleaseSigning } = require('../withReleaseSigning');

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

test('release build switches to the project keystore, debug stays debug', () => {
  const out = applyReleaseSigning(TEMPLATE);
  expect(out).toContain('storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))');
  expect(out.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1);
  expect(out).toMatch(/release \{\s*\/\/ Caution[^\n]*\n\s*signingConfig signingConfigs\.release/);
  expect(out).not.toContain("'android'\n            keyAlias System"); // no passwords written
  expect(applyReleaseSigning(out)).toBe(out); // idempotent
});

test('fails loudly if the template changes shape', () => {
  expect(() => applyReleaseSigning('android {}')).toThrow(/could not patch/);
});
