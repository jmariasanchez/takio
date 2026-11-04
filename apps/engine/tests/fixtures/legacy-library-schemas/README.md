# Legacy library schema fixtures

These SQL fixtures recreate the canonical Takio library schemas for versions 1 and 6 through 9. Each fixture sets the matching `PRAGMA user_version` and adds deterministic representative rows without changing the recovered schema.

The canonical schemas were recovered by exporting each final historical commit before the next schema version, installing with `bun install --frozen-lockfile`, opening a new database through that commit's `BunSqliteLibraryStore`, and dumping `sqlite_schema`.

| Version | Introducing commit | Canonical source commit | Recovered SQLite SHA-256 | Schema JSON SHA-256 |
| --- | --- | --- | --- | --- |
| v1 | `9e299f471432773cb24597d28a5d41027025d0b6` | `6bea702cdcccc82caf7714907acb6dac81f89eba` | `724ad5405460e70d1cf199b99246cae796f4a74dce6f2052f91d36c40075981a` | `8f924504a21e203630af7a5f4d62d6b2bb412d83ff761a09c79cab69d98dceb4` |
| v6 | `3761ac4f20001003e0c758f05f465e072cee77f8` | `cca4177f95b2dfde7112bcaaa225b792f5d56abe` | `736155346a62476923dccaf8563076553df37cc24653db9830c08b32bab85f3c` | `f2e7328d2e3492d62ebdec4f465c5846ce9680997033ba14a15e94f5e8c42b43` |
| v7 | `56098ab88ee38f72260fc672a6baa987e2cc243b` | `9af77cc2972d654bd62bd61b233240f0a48c3e29` | `e409bce2a09668267ec2205fc6884ebd0db1d40723dc445906a5def3a7aa162e` | `67f6cef9094bf56a69f2a9083f4f883dc647f6031763ea367c9d261d6bf7a6fb` |
| v8 | `51463f9bda5333984fce6885e274ce7ccba6dd73` | `776bc39f580e08d2247df479a7f3f1a4bd805a1c` | `14db87ef70e32783b83933d2cffc147ec880114a5fd2589ac2f090ac710a2c81` | `4e49789ed668fb7fe3d600e53bc15972aeab799748626aa732dcc81380912b6f` |
| v9 | `617c00a23a584cfd6e64d0dccdc407ffbbf23c69` | `c7c6a376a15a333663ad45b90b3270a686e179cf` | `6fd7926c31f19c53ca651e9ad584bbb8d4754a29f66b488fd66a8fcd16e62ec2` | `44cbf1e81e56b6c73289362803c590f1ae0e784c799f5f3dea124571b20c2253` |

The recovered source artifacts were located at `/Users/josesanchez/.jcode/scratch/takio-schema-recovery.TLkQPi/{v1,v6,v7,v8,v9}/`. The SHA-256 values above identify those inputs, not the SQL files in this directory.

Representative data progresses with the schema: v1 has one managed-format book; v6 adds normalized formats, rich metadata, tags, and trash; v7 adds managed fingerprints; v8 adds a duplicate-pair review; and v9 adds custom metadata and a pending source-file cleanup record representing adoption cleanup.
