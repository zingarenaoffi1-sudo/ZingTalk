# ZingTalk Android Release Keystore & Signing Details

This file contains the production signing credentials for **ZingTalk (com.zingtalk.com)**.
These credentials are used by GitHub Actions to build a **Signed Release APK** that can be installed on Android devices and Amazon Fire Tablets, and uploaded to the Amazon Appstore or Google Play.

---

## 🔑 Keystore Credentials

- **Keystore File**: `zingtalk-release.keystore` (Root of repository)
- **Keystore Format**: PKCS12
- **Keystore Password**: `zingtalk123456`
- **Key Alias**: `zingtalk`
- **Key Password**: `zingtalk123456`
- **Validity**: **50 Years** (Valid until Year 2076)
- **Organization / CN**: `CN=ZingTalk, OU=Mobile, O=ZingTalk, L=Delhi, ST=Delhi, C=IN`

---

## 🛡️ Certificate Fingerprints (SHA-1 & SHA-256)

Add these fingerprints to your **Firebase Console** under:
*Project settings* -> *General* -> *Your apps* -> *Android app (com.zingtalk.com)* -> *Add fingerprint*.

### SHA-1:
```
22:25:E7:40:7A:EF:0E:47:AB:83:3E:E9:51:4A:DD:FE:62:FC:A5:69
```

### SHA-256:
```
A5:09:11:14:BD:91:46:55:C4:2F:E3:8E:CE:5D:C1:2C:46:0C:F5:28:EE:5C:15:2E:47:1D:B5:04:6A:13:8D:39
```

---

## 🚀 GitHub Actions Output
When you push code or run the **Build Android APK** workflow in GitHub Actions, it will generate:
- **`ZingTalk-Release-Signed-APK`**: The production-signed APK ready to install or publish.
- **`ZingTalk-Debug-APK`**: Standard debug APK for development testing.
