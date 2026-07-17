plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.todopup.usage"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.todopup.usage"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "2.3"
    }

    buildTypes {
        // Debug-signed only: a debug APK is fine for personal sideloading.
        // No release keystore / signing ceremony needed.
        getByName("debug") {
            isMinifyEnabled = false
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
