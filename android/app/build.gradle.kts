plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.todopup.usage"
    compileSdk = 34
    testBuildType = providers.gradleProperty("testBuildType").getOrElse("debug")

    defaultConfig {
        applicationId = "com.todopup.usage"
        minSdk = 26
        targetSdk = 34
        versionCode = 10
        versionName = "3.0"
        testInstrumentationRunner = providers.gradleProperty("testRunner")
            .getOrElse("com.todopup.usage.StorageInstrumentation")
        manifestPlaceholders["appLabel"] = "@string/app_name"
        manifestPlaceholders["appScheme"] = "todopup"
    }

    buildTypes {
        // Debug-signed only: a debug APK is fine for personal sideloading.
        // No release keystore / signing ceremony needed.
        getByName("debug") {
            isMinifyEnabled = false
        }
        create("qa") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".qa"
            matchingFallbacks += "debug"
            manifestPlaceholders["appLabel"] = "Datapom QA"
            manifestPlaceholders["appScheme"] = "todopup-qa"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    testImplementation("junit:junit:4.13.2")
}

val journalAssets by tasks.registering(Sync::class) {
    from(rootProject.projectDir.parentFile.resolve("static")) {
        include("style.css", "custom-select.js", "custom-color.js", "datetime-picker.js", "offline-map.js", "location-day*.js", "location-analytics.js", "media-ui.js", "photo-edit.js", "media-entry.js", "media-settings.js", "mobile-journal.*", "journal-richtext.js", "img/*-pompom.gif")
    }
    into(layout.buildDirectory.dir("generated/journal-assets/journal"))
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/journal-assets"))
tasks.named("preBuild").configure { dependsOn(journalAssets) }
