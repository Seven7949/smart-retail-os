/**
 * Expo config plugin: sign release builds with the project's own keystore.
 *
 * The React Native template signs release APKs with the PUBLIC debug key, so
 * anyone could ship an "update" that takes over the app's data. When
 * ANDROID_KEYSTORE_PATH is set at prebuild time (CI), this switches the release
 * build to a dedicated signing config. Passwords are read from environment
 * variables by Gradle at build time and are never written to disk.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }`;

function applyReleaseSigning(gradle) {
  if (gradle.includes('System.getenv("ANDROID_KEYSTORE_PATH")')) return gradle;
  let out = gradle.replace(/signingConfigs\s*\{/, RELEASE_CONFIG);
  out = out.replace(/(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
  if (out === gradle || !out.includes('signingConfig signingConfigs.release')) {
    throw new Error('withReleaseSigning: could not patch android/app/build.gradle');
  }
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (process.env.ANDROID_KEYSTORE_PATH) cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.applyReleaseSigning = applyReleaseSigning;
