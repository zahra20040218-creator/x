import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}


// Reads android/local.properties if present, so a developer can keep their
// Maps key out of both the repository and their shell profile.
val localProperties = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { stream -> load(stream) }
}

// Release signing.
//
// Values come from android/key.properties - gitignored, and pointing at a
// keystore that lives OUTSIDE the repository - or from the environment, for CI.
//
// There is deliberately NO fallback to the debug key. The template's fallback
// produces a bundle Play rejects, and the case where Play does not reject it is
// worse: an artifact everyone believes carries the upload key when it does not.
// Signing keys cannot be changed after the first upload, so a mistake here is
// permanent.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { stream -> load(stream) }
}

fun signingValue(key: String, env: String): String? =
    (keystoreProperties.getProperty(key) ?: System.getenv(env))?.takeIf { it.isNotBlank() }

val uploadStoreFile = signingValue("storeFile", "ANDROID_KEYSTORE_PATH")
val uploadStorePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
val uploadKeyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS")
val uploadKeyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD")

val hasUploadKey = uploadStoreFile != null && uploadStorePassword != null &&
        uploadKeyAlias != null && uploadKeyPassword != null

// Fails the build rather than emitting an unsigned or debug-signed release.
gradle.taskGraph.whenReady {
    val releasing = allTasks.any {
        it.name.contains("Release") &&
            (it.name.startsWith("assemble") || it.name.startsWith("bundle"))
    }
    if (releasing && !hasUploadKey) {
        throw GradleException(
            "Release build requested with no upload key. Provide " +
                "android/key.properties (storeFile, storePassword, keyAlias, " +
                "keyPassword) or the ANDROID_KEYSTORE_PATH / " +
                "ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / " +
                "ANDROID_KEY_PASSWORD environment variables. See " +
                "docs/RELEASE.md. Never sign a release with the debug key."
        )
    }
}

android {
    namespace = "iq.rideapp.rideapp_rider"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Final and permanent: an applicationId cannot be changed once
        // published, and this one is already in the built artifacts.
        applicationId = "iq.rideapp.rideapp_rider"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // Google Maps API key.
        //
        // Read from -PMAPS_API_KEY, then MAPS_API_KEY in the environment, then
        // android/local.properties. NEVER committed - CLAUDE.md 9 forbids
        // secrets in the repository, and local.properties is gitignored by
        // Flutter's own template.
        //
        // Defaults to EMPTY rather than to a placeholder string. An empty key
        // makes the Maps SDK fail with an authentication error the app can
        // catch and explain; a fake key produces a blank grey tile the user
        // cannot distinguish from a network problem.
        val mapsApiKey: String =
            (project.findProperty("MAPS_API_KEY") as String?)
                ?: System.getenv("MAPS_API_KEY")
                ?: localProperties.getProperty("MAPS_API_KEY")
                ?: ""
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey

    }

    signingConfigs {
        // Created only when the material exists, so a debug-only checkout still
        // configures. The task-graph check above is what stops a release build
        // silently proceeding without it.
        if (hasUploadKey) {
            create("upload") {
                storeFile = file(uploadStoreFile!!)
                storePassword = uploadStorePassword
                keyAlias = uploadKeyAlias
                keyPassword = uploadKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasUploadKey) signingConfigs.getByName("upload") else null

            // R8 is deliberately left off. Flutter compiles Dart ahead of time,
            // so shrinking only touches the Java/Kotlin shim - a few hundred KB
            // against a real risk: firebase_messaging and google_maps_flutter
            // both resolve classes reflectively, and a missing keep rule fails
            // at runtime on a device rather than at build time here. Turning it
            // on is a one-line change once there is a handset to verify it on.
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
