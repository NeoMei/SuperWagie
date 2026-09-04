{
  "targets": [
    {
      "target_name": "secure_fs_native",
      "sources": ["src/native/secure-fs-native.c"],
      "defines": ["NAPI_VERSION=10"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "WarningLevel": 4,
          "WarnAsError": "true",
          "DisableSpecificWarnings": ["4201"]
        }
      }
    }
  ]
}
