plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val projectRootDir = rootProject.projectDir.parentFile
val generatedNodeProjectDir = layout.buildDirectory.dir("generated/nodejs-project")
val generatedNodeProjectLukerDir = generatedNodeProjectDir.map { it.dir("luker") }
val prebuiltBundlesRelativePath = "_prebuilt-bundles"
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

val collectPrebuiltBundles by tasks.registering(Sync::class) {
    dependsOn(prebuildFrontendBundles)
    val sourceRoot = File(projectRootDir, "dist/_webpack")
    from(sourceRoot) {
        // Webpack writes outputs to dist/_webpack/<cacheVersion>/output/*.js.
        // Flatten so the runtime can resolve them by filename without knowing
        // the cache version, which is git-rev-dependent and not available
        // inside nodejs-mobile. build-lib.js passes pruneCache:true so only
        // the current cacheVersion folder exists; the FAIL strategy guards
        // against a stray sibling sneaking in via aborted/parallel builds.
        include("*/output/*.js")
        eachFile {
            path = name
        }
        includeEmptyDirs = false
    }
    duplicatesStrategy = DuplicatesStrategy.FAIL
    into(generatedNodeProjectDir.map { it.dir(prebuiltBundlesRelativePath) })
}

val prepareNodeProject by tasks.registering(Sync::class) {
    from(projectRootDir) {
        include("server.js")
        include("webpack.config.js")
        include("package.json")
        include("package-lock.json")
        include("plugins.js")
        include("config.yaml")
        include("src/**")
        include("public/**")
        include("default/**")
        include("plugins/**")
        include("node_modules/**")

        exclude("**/.git/**")
        exclude("**/.github/**")
        exclude("android-app/**")
        exclude("backups/**")
        exclude("colab/**")
        exclude("docker/**")
        exclude("docs/**")
        exclude("tests/**")
        exclude("data/**")
        exclude("**/*.map")
        exclude("**/.DS_Store")
    }
    into(generatedNodeProjectLukerDir)
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

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

tasks.configureEach {
    val taskName = name
    val requiresPreparedNodeProject =
        (taskName.startsWith("merge") && taskName.endsWith("Assets")) ||
        taskName.startsWith("lintVitalAnalyze") ||
        taskName.endsWith("LintVitalReportModel")
    if (requiresPreparedNodeProject) {
        dependsOn(prepareNodeProject)
        dependsOn(collectPrebuiltBundles)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
