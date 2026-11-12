plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val projectRootDir = rootProject.projectDir.parentFile
val generatedNodeProjectDir = layout.buildDirectory.dir("generated/nodejs-project")
val stagingNodeProjectDir = layout.buildDirectory.dir("intermediates/mobile-runtime-staging")
val jniLibsDir = file("src/main/jniLibs")
val availableNodeAbis = jniLibsDir
    .listFiles()
    ?.filter { it.isDirectory && File(it, "libnode.so").isFile }
    ?.map { it.name }
    ?.toSet()
    ?: emptySet()
val packageJsonFile = File(projectRootDir, "package.json")

fun parseAppVersionName(packageJson: File): String {
    val versionMatch = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(packageJson.readText())
        ?: error("Unable to read version from ${packageJson.path}")
    return versionMatch.groupValues[1]
}

fun parseAppVersionCode(versionName: String): Int {
    val semverMatch = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)").find(versionName)
        ?: error("Version '$versionName' is not in semver format (major.minor.patch)")
    val (major, minor, patch) = semverMatch.destructured
    return major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt()
}

val appVersionName = parseAppVersionName(packageJsonFile)
val appVersionCode = parseAppVersionCode(appVersionName)

// Pre-compile the three frontend Webpack bundles at build time so the
// APK ships them as static assets. Skips the (very slow) in-process
// Webpack compile that would otherwise run on the phone on first launch.
val prebuildFrontendBundles by tasks.registering(Exec::class) {
    workingDir = projectRootDir
    commandLine("node", "docker/build-lib.js")
    val outputDir = File(projectRootDir, "dist/_webpack")
    inputs.file(File(projectRootDir, "webpack.config.js"))
    inputs.file(File(projectRootDir, "docker/build-lib.js"))
    inputs.file(File(projectRootDir, "src/middleware/webpack-serve.js"))
    inputs.file(File(projectRootDir, "public/lib-bundle-core.js"))
    inputs.file(File(projectRootDir, "public/lib-bundle-optional.js"))
    inputs.file(File(projectRootDir, "public/lib-bundle-codemirror.js"))
    inputs.file(File(projectRootDir, "package.json"))
    inputs.file(File(projectRootDir, "package-lock.json"))
    outputs.dir(outputDir)
    outputs.cacheIf { true }
}

val prepareNodeProject by tasks.registering(Exec::class) {
    dependsOn(prebuildFrontendBundles)
    workingDir = projectRootDir
    val outAssetsDir = generatedNodeProjectDir.get().asFile
    val outStagingDir = stagingNodeProjectDir.get().asFile
    val tarFile = File(outAssetsDir, "runtime-bundle.tar")
    val versionFile = File(outAssetsDir, "runtime-tree-version.txt")
    val bootstrapFile = file("src/main/assets/nodejs-project/bootstrap.js")

    doFirst {
        outAssetsDir.deleteRecursively()
        outAssetsDir.mkdirs()
    }

    commandLine(
        "node",
        File(projectRootDir, "scripts/stage-mobile-runtime.mjs").absolutePath,
        "--repo-root",
        projectRootDir.absolutePath,
        "--output-dir",
        outStagingDir.absolutePath,
        "--bootstrap",
        bootstrapFile.absolutePath,
        "--tar",
        tarFile.absolutePath,
        "--version-file",
        versionFile.absolutePath,
    )

    inputs.file(File(projectRootDir, "scripts/stage-mobile-runtime.mjs"))
    inputs.file(File(projectRootDir, "server.js"))
    inputs.file(File(projectRootDir, "webpack.config.js"))
    inputs.file(File(projectRootDir, "package.json"))
    inputs.file(File(projectRootDir, "package-lock.json"))
    inputs.file(File(projectRootDir, "plugins.js"))
    inputs.file(bootstrapFile)
    inputs.dir(File(projectRootDir, "src"))
    inputs.dir(File(projectRootDir, "dist/_webpack"))
    outputs.file(tarFile)
    outputs.file(versionFile)
}

android {
    namespace = "com.luker.app"
    compileSdk = 34
    
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "com.luker.app"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName

        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }

        ndk {
            if (availableNodeAbis.isNotEmpty()) {
                abiFilters += availableNodeAbis
            } else {
                // Safe default for most real devices when libnode ABI set has not been prepared yet.
                abiFilters += "arm64-v8a"
            }
        }
    }

    val releaseStoreFile = System.getenv("ANDROID_KEYSTORE_FILE")
    val releaseStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
    val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
    val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
    val hasReleaseSigning = listOf(
        releaseStoreFile,
        releaseStorePassword,
        releaseKeyAlias,
        releaseKeyPassword,
    ).all { !it.isNullOrBlank() }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isDebuggable = true
            // Share the release signature when CI provides it so a debug APK
            // is install-as-upgrade compatible with a previously installed
            // release APK. Falls back to AGP's default debug.keystore locally.
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(generatedNodeProjectDir)
            jniLibs.srcDir("src/main/jniLibs")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }

    androidResources {
        // AAPT's default ignore pattern contains "<dir>_*", which silently drops
        // underscore-prefixed directories from APK assets. Node packages keep
        // runtime modules in such directories, so requiring them fails on device.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
        noCompress += "tar"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

tasks.configureEach {
    val taskName = name
        val requestedTasks = gradle.startParameter.taskNames
        val isUnitTestOnlyRun = requestedTasks.isNotEmpty() &&
            requestedTasks.all { it.contains("UnitTest", ignoreCase = true) || it == "test" }
        val requiresPreparedNodeProject =
            !isUnitTestOnlyRun && (
                (taskName.startsWith("merge") && taskName.endsWith("Assets") && !taskName.contains("UnitTest")) ||
                taskName.startsWith("lintVitalAnalyze") ||
                taskName.endsWith("LintVitalReportModel")
            )
    if (requiresPreparedNodeProject) {
        dependsOn(prepareNodeProject)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
}
