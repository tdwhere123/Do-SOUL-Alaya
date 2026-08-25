# S16 order-level dump bound

Owner pair: ancestor E1 quality `2026-08-23T055902Z` vs G21 E1 ranking-preserve `2026-08-24T094913Z`.
Secondary pair (not the owner): ancestor E0 `2026-08-23T040412Z` vs G21 E0 `2026-08-24T114902Z`.

Freeze: 94 KPI-scorable questions. Gold = fused-best (`bestGold`). Delivered identity = `object_id` from `candidates.final_rank<=5`, else `delivered_results.rank<=5`. `selection_order` is Gamma admission, not R_obj. Family-max uses live `aggregateFamilyContributions` over legal families semantic, lexical, structural, graph_path, temporal_facet. Occupier max-stream labels are not R_obj.

KPI any@5: ancestor E1 78/94 → G21 E1 63/94 (4 gained / 19 lost, net -15). Dump full-gold@5 (every gold `final_rank<=5`): ancestor 39/94 → G21 27/94. KPI ratios ancestor 0.4148936170212766 vs G21 0.2872340425531915.

## Class counts (E1 owner)

| class | n |
| --- | --- |
| unchanged_hit | 0 |
| unchanged_miss | 0 |
| head_recovered | 4 |
| waist_lost | 19 |
| other_gain | 0 |
| other_loss | 0 |
| set_churn_same_hit | 71 |

- **unchanged_hit** (0): —
- **unchanged_miss** (0): —
- **head_recovered** (4): `001be529` `6b168ec8` `6f9b354f` `726462e0`
- **waist_lost** (19): `21436231` `29f2956b` `2ce6a0f2` `3d86fd0a` `545bd2b5` `577d4d32` `58ef2f1c` `5d3d2817` `66f24dbb` `7024f17c` `86f00804` `af8d2e46` `b86304ba` `c4a1ceb8` `c5e8278d` `d52b4f67` `faba32e5` `gpt4_7fce9456` `gpt4_d84a3211`
- **other_gain** (0): —
- **other_loss** (0): —
- **set_churn_same_hit** (71): `0862e8bf` `0a995998` `118b2229` `15745da0` `19b5f2b3` `1e043500` `1faac195` `2318644b` `25e5aa4f` `28dc39ac` `2e6d26dc` `311778f1` `36580ce8` `36b9f61e` `37d43f65` `3a704032` `3b6f954b` `3f1e9474` `4100d0a0` `46a3abf7` `4fd1909e` `51a45a95` `58bf7951` `60d45044` `6ade9755` `6cb6f249` `6d550036` `7527f7e2` `75499fd8` `76d63226` `80ec1f4f` `853b0a1d` `8550ddae` `86b68151` `88432d0a` `8a137a7f` `8e9d538c` `8ebdbe50` `94f70d80` `95bcc1c8` `a06e4cfe` `a82c026e` `aae3761f` `ad7109d1` `b320f3f8` `b5ef892d` `bc8a6e93` `c14c00dd` `c19f7a0b` `c8c3f81d` `c960da58` `caf9ead2` `ccb36322` `d23cf73b` `d682f1a2` `dccbc061` `dd2973ad` `e01b8e2f` `e47becba` `e831120c` `ec81a493` `f4f1d8a4` `f8c5f88b` `gpt4_15e38248` `gpt4_2ba83207` `gpt4_2f8be40d` `gpt4_5501fe77` `gpt4_59c863d7` `gpt4_a56e767c` `gpt4_d12ceb0e` `gpt4_f2262a51`

`set_churn_same_hit` splits: hit-hit membership 59, miss-miss membership 11, order-only 1 (`8a137a7f`). The class name is the spec label for any@5-stable membership or order change, including miss-miss.

Known gained list match: yes.
Known lost list match: yes.
`head_recovered` is the known +4. `waist_lost` is the known −19 (15 are S12 waist E1-hits `21436231` `29f2956b` `2ce6a0f2` `3d86fd0a` `545bd2b5` `577d4d32` `5d3d2817` `66f24dbb` `7024f17c` `af8d2e46` `b86304ba` `c4a1ceb8` `c5e8278d` `faba32e5` `gpt4_d84a3211`; remainder `58ef2f1c` `86f00804` `d52b4f67` `gpt4_7fce9456`).

## Collateral churn (every any@5-stable membership/order change and every flip)

Unchanged hit 0, unchanged miss 0. On E1, every scorable question changed membership or order. This is not only +4/−19.

| id | class | churn | anc@5 | g21@5 | anc fused/sel/final | g21 fused/sel/final | gained object_id | lost object_id | head displaced | conflict | same slot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `001be529` | head_recovered | — | N | Y | 2 / 107 / — | 2 / 10 / 1 | `d75dd75f-0f1e-478b-a07e-cf392e304ebf` `3d353dbd-87ef-48e4-9a47-9f5ce0759f7b` `907e31d2-5e21-4ac5-b6de-b6117bc03956` `8d1e62d0-0b0d-4486-8c84-cdad843db79b` `9a94cd23-cfb1-480f-ab1b-ba847380e56f` | `a59b1cf7-8ffa-4d03-a689-637403489196` `6712d7a2-0b55-4891-bdd9-2b6745e2a5c1` `9a37c33c-902a-4648-9291-cbe10184f3dd` `6b31f7c8-f4f5-48a3-81c7-058b578d63b8` `a159f513-01b4-4f71-8724-808dad027e56` | Y | N | N |
| `6b168ec8` | head_recovered | — | N | Y | 3 / 6 / 6 | 3 / 3 / 3 | `8b1fffdd-5c27-473f-a43f-356476ee1902` `da5579cf-197b-4628-aece-31d90af7153f` `fa5756be-0158-42ee-a473-7199fa844791` `d090da4a-1add-4a9e-932e-c79b10cae885` | `1d8e183a-4fda-46f7-b788-1d3ed0e58ad6` `e08b401f-08d9-4fe6-b1fe-efa07da3760d` `f64bd2ee-fee7-429e-a363-f6715e40334b` `5a25a16f-f75d-4588-a453-be1117ce166a` | Y | N | N |
| `6f9b354f` | head_recovered | — | N | Y | 1 / 31 / — | 1 / 1 / 1 | `275d0777-abcf-42f9-ad75-60079a770661` `118654e9-e378-4e2c-a8fb-0d77f384bf1b` | `cb10a7d6-4c30-47fa-a4c5-59f7266e4944` `a7a6d851-f97c-4786-8455-12db6cd6f5d9` | Y | N | N |
| `726462e0` | head_recovered | — | N | Y | 1 / 143 / — | 1 / 1 / 1 | `6b278500-c4d3-4f27-94ba-837386f46852` `91b04bdf-be2f-4517-88c8-60a5e8a0a70f` `bb8d0bf5-4afc-4a3a-b8ad-f34bf56035c0` `70da762b-9b68-4ea7-bdc0-32eee0cfbb1e` | `4fb86c59-b0e6-4508-a9af-80bca24127fc` `90a20dad-83d3-4839-a8b5-40854ed30e78` `1aacc540-aab1-4a75-86fd-0ccaf0d71125` `63eb927a-3503-4cbc-b7cc-6151d9eca246` | Y | N | N |
| `21436231` | waist_lost | — | Y | N | 19 / 1 / 1 | 19 / 11 / — | `9ffbdd7b-981a-4cfe-a711-78bb52d3c6e6` `6026c777-5989-4381-a33b-d383b705440a` `a2b8700f-a897-4b51-a3e6-22aa5ef1f3bf` `eb558061-3d57-46a8-9fdb-c12f20ca5499` `38aca50a-77fd-4426-a1d6-79080d5e7b75` | `a6e88a19-ca88-42c9-a7b5-d476f3ac0c25` `836cdca3-5d14-4cbe-aeaf-04629d2ffb74` `615ac3f8-842b-4bc6-907d-d8a038643e4c` `0943f1f2-942a-49a2-8d27-9f22f12fa491` `f002dbfb-a876-4b9a-80ec-a0abc75008d5` | N | N | N |
| `29f2956b` | waist_lost | — | Y | N | 18 / 1 / 1 | 18 / 11 / — | `c86c4975-be39-49e8-bc47-fede4c782529` `d7e8ee51-45b8-4381-851b-f02583c3f907` `86426c68-f614-4a5e-845a-53529d079639` `55460884-e401-4a07-9cac-3be7c2e679c7` `e604ced5-4c45-465f-aa84-f133ac7e267c` | `71e14885-3a33-47da-8635-aa684dc6e128` `07ec53d2-7a3d-4544-872a-417774f6de3c` `10cf11b4-3c29-4948-8735-dd9e6035b239` `576cf0ad-245c-4b93-ac4d-7a7efb7e55aa` `e7ac0f76-37a4-447a-b883-1494452aebf8` | N | N | N |
| `2ce6a0f2` | waist_lost | — | Y | N | 9 / 11 / — | 9 / 8 / 8 | `733a4f0f-d7c3-4ae1-b54f-43eef0ac7b24` `821f8a4b-5f79-406f-8b10-b8c8c4af3050` `a1b83acc-25c3-4998-a9aa-dc2034cf86d4` `afabad6f-d193-403f-ae44-e2551679420c` `efc70588-ce79-4646-bce8-4fa8473eb58d` | `0aeed925-56e5-400f-81e6-ecd1e0b68c56` `7f2beda3-f74e-4f53-9d8c-ea949b7ea01e` `cba7762d-8a00-4252-ae6e-33e76e5a56f8` `de2bb0b3-ddf0-4daa-9c1d-6fcb7521bd10` `630e4cc9-9db8-4aee-be7d-b8adc911ee4b` | N | N | N |
| `3d86fd0a` | waist_lost | — | Y | N | 19 / 5 / 1 | 19 / 15 / — | `527497fb-8e57-4cca-b5b6-b211da7c0172` `2adf45c8-3dee-4c47-8d37-14c55bc3bd50` `491e11c7-0f8d-4050-bfb6-742444ccd75f` `0444b938-9fe4-4bbd-9a92-57853a5a8b16` | `c0e0917f-126b-44a2-9726-858f6dbf13d8` `d43d0328-95d1-4e2e-93e2-cbf106047f78` `b899c79a-a08f-47b8-9809-3b0c50dce838` `6d84ffe2-8d91-4c44-ab9d-19f282bac4fb` | N | N | N |
| `545bd2b5` | waist_lost | — | Y | N | 10 / 1 / 1 | 10 / 10 / 10 | `c5fc357d-b69e-4876-8818-896f79886b0c` `8ad313c2-832e-4fec-9a7c-41a4b3947fb3` `8632c6cc-e2aa-4c03-8330-d954f4fb0e16` `a96723d8-43d3-42c3-8b66-cbd8df0a5852` `578c7eca-8e7a-4471-8d87-bd05a5bbf3c9` | `ac290368-9d7b-4ac4-abab-1eaf941b3884` `9396e139-4b49-47f4-98c5-07edcd645b89` `26c01f8a-ccbf-47fc-9d36-b7d8c43ed9f8` `f53e4d81-5242-4c0f-b502-b9ec662dd9df` `f16c2346-c52f-40b9-b1ad-012077eb176b` | N | N | N |
| `577d4d32` | waist_lost | — | Y | N | 16 / 2 / 2 | 16 / 11 / — | `b8be55d5-a672-440b-ae21-64b544340d08` `940f1fee-5f25-477c-a3b8-58befd64c63a` `ed1e7c7d-0bf8-491c-90b3-f69a12520325` `79454ccd-b50c-42cf-ad7d-644984710bdc` `9dd71499-f02a-4b35-acd9-d4a8d45b1de1` | `d5b33001-97e6-4ed2-a60c-5a459ef5a344` `bd5de949-ddd8-429c-9ca1-8215346601f7` `e2c99bd8-1ea7-4816-a9f9-2be7c63aaa35` `4e9d2a40-591e-4e71-8c53-d39a760af0b9` `7cab0899-4405-49e8-837b-e590230345d1` | N | N | N |
| `58ef2f1c` | waist_lost | — | Y | N | 8 / 21 / — | 8 / 8 / 8 | `d1ea7322-85a0-49fb-97ba-ec3848fb0002` `bd39e6fe-e607-41c7-8154-e0d18417e7a8` `b0ac2f6a-c2b9-47aa-a31c-77ce53f395dd` `134eeb21-e508-4920-9b5c-46d55ffce897` `7a5236f9-f0b6-4a58-a013-0da081f780f0` | `08646c20-08cd-4233-81be-81b8f0c85e9d` `7593d1ff-50e8-4c83-ae05-863d8fbf3db2` `73fafc0e-81aa-4596-ba13-b6635112c480` `35ad468c-6758-4d98-ba88-4b50b2062dcf` `dbcf6e28-773d-426c-bd29-e45a8d39e597` | N | N | N |
| `5d3d2817` | waist_lost | — | Y | N | 12 / 2 / 2 | 12 / 11 / — | `d5f51bd8-3dd6-49e6-aac6-2c62d3c4656e` `23c02fdf-23b7-4d48-a572-15922dc50a39` `305b5485-7a26-439c-be59-93f98695f82f` `2777a7b5-1f26-4958-94f1-590b0bee8acb` | `105b074d-1f88-48ba-9a1b-4a863ca490a2` `92bc7ea5-62ef-424c-aae8-f5c2c34494bb` `33cbe0ab-fbbd-4c88-9d41-1b8af0a9f589` `8d0de172-192b-4f89-928a-15cd753c1a81` | N | N | N |
| `66f24dbb` | waist_lost | — | Y | N | 8 / 1 / 1 | 8 / 8 / 8 | `cd39cc13-2b81-4dc9-8e69-b085c5496f55` `a136d6b7-8126-46f1-a406-a201ad14f5d5` `49845426-536b-4b04-835f-c6f3d8b9852c` `25ec299a-bbd5-4f6b-beca-ab1de9ab4891` `43f0f1eb-13a2-43d7-8f13-cddbe7022028` | `029829c0-fff8-4a64-9bf2-0ee1651470c4` `babc5e64-6c8e-4221-bb03-e50d01cb196b` `659bb1c5-baa9-4626-bfab-6ddafc5bcad0` `77b9fd3f-d46a-470a-b0a4-80b691eee3bb` `e74d53e7-5981-4d04-8ab1-7f426b0c7877` | N | N | N |
| `7024f17c` | waist_lost | — | Y | N | 16 / 2 / 2 | 16 / 11 / — | `79d23066-7ee9-446f-8941-a9896fe49516` `e442b91f-0da2-4676-a346-9189369f302d` `be8d2ff3-13cc-4a24-8716-73598e30f239` `912839cf-ebe5-41dc-8204-0c4502874a01` | `f3ea60b2-97ef-4ecf-a4fe-70488c065ef7` `663dd733-0643-4079-a502-eefc4e5c5c27` `fff3ce92-c76b-4929-ba13-e58418e8da6d` `025094a1-1c9e-41b5-a71f-b7d9bfbad3b2` | N | N | N |
| `86f00804` | waist_lost | — | Y | N | 9 / 4 / 4 | 9 / 9 / 9 | `dcc7430f-cdc4-4863-9ff0-36feea345773` `b936eedb-21e7-440a-ac7b-7f3f2de4b0ce` `0cf1bcc1-ae2c-4184-90d6-cbafa9d58c4b` `bc09dc1c-3839-4f89-8d66-851e6b804dfd` `388a1384-3e7b-4056-96d9-8285791f26ec` | `fa2d1f41-bab0-4407-94bb-64327ef874cc` `ba1308fd-e223-42f7-b716-e90b8c18e6b5` `6493ca73-e4ee-44da-a1be-66a5dfb44f61` `2ce8b8d9-074d-42e9-987a-13068ecacc6d` `a791bf42-72d3-4f28-a080-9e39db65d96a` | N | N | N |
| `af8d2e46` | waist_lost | — | Y | N | 13 / 5 / 5 | 13 / 13 / — | `a4146279-4454-4ef8-8149-11a30479e23a` `c3c941ea-fc27-4326-ba3a-f05c73a02ea7` `025213ac-9b50-43e9-8c49-1bcd53ddc5a3` `7c0ebae5-866e-4dd6-acaa-33e2189e4ebb` `d3a1c057-891a-4c00-bfdd-ae7edda2f3fd` | `95eef27d-a9d4-4570-8636-82d54e57ecce` `f606d8a2-6d3d-4611-8e6a-a2b8ac039add` `b45d87e2-7f0a-4c14-9d1d-1904eacd89b7` `8966f404-ad02-4664-b7d3-32eeb4f9d7ae` `d535f6b4-b440-421c-8a5d-d0953ba61bef` | N | N | N |
| `b86304ba` | waist_lost | — | Y | N | 10 / 4 / 4 | 10 / 10 / 10 | `cfd98862-3740-4872-9362-89a67a020542` `5ec78113-f94c-4666-91c5-3b46be12e5df` `784f6f3f-8e85-4010-81e2-4da3c8c58177` `8b955836-b705-4a97-84ce-89aa5a35c091` `455ee118-5a24-43fe-8356-01e428e3acc2` | `94e0c278-46dd-48b1-ac1b-f626c8238dc0` `c76707ff-fa53-4ba0-ba95-bac45265c74b` `5dcedccd-a1de-4bc6-aaae-8cd6006603b3` `1c1149c8-1582-4e13-928f-54a5d79c826d` `d53367bf-9460-4216-89dd-f32c1d37a21c` | N | N | N |
| `c4a1ceb8` | waist_lost | — | Y | N | 6 / 5 / 5 | 6 / 6 / 6 | `d94575d3-b625-4513-a2e1-4c75ad9c5d15` `cbd09dfa-f3b1-4004-b400-3b2887c2723a` | `f98b70c7-ec3b-4f81-8b16-06c9030d0138` `0842c23d-a762-4429-b4b4-5ae170a10d4f` | N | N | N |
| `c5e8278d` | waist_lost | — | Y | N | 13 / 1 / 1 | 13 / 11 / — | `944a2c47-e5d4-4e0d-a1f6-3c11f31213e8` `5f4f9cc0-8179-4f9c-b450-e0b34c62f9b6` `54856b6e-3ffb-4482-b500-ff6f6d538b79` `c1621c74-6fd9-4126-84f4-1c9bcbe7b5f9` `e4ff6135-8639-425d-b332-c961c420f3d8` | `f7f94523-9fd8-47f9-8518-16454b14d8c6` `d11e8300-a587-45f6-8434-ba02011fdd90` `564a067f-cb22-4286-ab2e-cfb86e71d891` `5d4cf598-cf3c-4fb2-b9ee-97fde5365073` `74975be0-d45f-4cd5-8caf-ad9bd2f04454` | N | N | N |
| `d52b4f67` | waist_lost | — | Y | N | 25 / 1 / 1 | 25 / 11 / — | `3b03aa3a-f0a3-4043-a36a-eea10abcf634` `22b42790-d3e7-4c96-93cc-cdd51a9039c0` | `c016c202-d2c6-4bfe-8034-009e3541c980` `bfa3de6f-1ae6-4ce5-a375-0b219deb3888` | N | N | N |
| `faba32e5` | waist_lost | — | Y | N | 14 / 1 / 1 | 14 / 11 / — | `a9cf50af-cb2c-47bd-b97a-db595df21fe9` `fe13463f-4f81-4c5d-bb87-f5e8e7ec5a04` `487ec8f1-9e62-4eeb-aade-326db1db5bf2` `299680ea-972c-4200-987d-e4752bbb3f17` | `7536c12e-ccdb-4194-92fe-2947e47a3753` `63d4b033-b4b1-49af-8ed0-61aae9ac7abe` `1d8abaa1-e8bd-43f0-aa77-ac34acb13ad2` `01d57b4d-483b-4a20-8336-e487fd13401a` | N | N | N |
| `gpt4_7fce9456` | waist_lost | — | Y | N | 10 / 3 / 3 | 10 / 10 / 10 | `c3680c93-24d0-44d6-8264-ecc2a00ea7c1` `b075a94c-698d-47f8-9d73-30a427e09c7c` `7ceaf1f0-3986-4e4a-a60e-fde5a73c878e` `15a35633-ea7a-40ed-bd81-8ea3a580fab6` `b940f73d-7d3d-4ae6-9742-f44aaa4f5cbb` | `e3a21d06-686d-4509-8863-edb46d250a4a` `1fd60dca-91d0-4092-89d9-b71fe43b9e7f` `fcf8e1fd-7dfa-4c25-ab07-07c8c2e3bf4f` `30f885c9-3f40-4e5b-aaf9-37fa33b92271` `da462994-b7a7-4e10-9d88-655ae350eec7` | N | N | N |
| `gpt4_d84a3211` | waist_lost | — | Y | N | 31 / 7 / 7 | 31 / 17 / — | `9318fe60-e343-404f-89fe-c2226ff12a23` `04bb24f3-171a-429f-8f24-600c91e8e024` `a0774cbd-68ac-4e8b-ae4e-a16e4bae93b4` `d58bbb3f-4412-495a-a2ca-5e7f0888a64e` | `eb96c62d-a5c2-40de-900f-38c467f817cd` `228bf85e-8046-4527-8606-1e573104acee` `9379fcad-ee58-4bc9-b632-436d60215ead` `ea46c37d-04b5-4ea7-87d5-f224e7dfd4c7` | N | N | N |
| `0862e8bf` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `48b53acc-2e9e-47ff-9153-eef930267c79` `f562626e-ff4c-4cc4-8f30-be7f50e00537` `b1241a81-2dc6-4d0a-a531-885b67b34e46` | `b54b1e8c-d40f-4834-96c0-5efaeab6574a` `c67ded11-a5d7-400a-b455-07102e2ea572` `63f04371-6b34-4f23-a42b-acdb89afbaad` | N | N | N |
| `0a995998` | set_churn_same_hit | membership | N | N | 14 / 38 / — | 14 / 34 / — | `328903e5-ed2a-4a38-bea1-1f17d80b42f0` `4c5da51d-9b38-4543-9f62-267e84a9a683` `68ef1efe-d82a-4c0a-a05c-77326c2eed65` | `34554151-8ab5-4621-9ef1-8a16eef8a3ae` `c9a2db2a-f919-4cda-a572-e19b493feecd` `8a4a1a0b-fa18-4845-b35f-2c64fde16209` | N | N | N |
| `118b2229` | set_churn_same_hit | membership | Y | Y | 2 / 3 / 1 | 2 / 4 / 2 | `6d8c47be-c37c-458f-ad65-534d71e6889a` `45629b7a-9c4a-4e25-83c6-bd9f54afe6a7` | `1fb01e5e-e328-4342-b976-da3f9b1063aa` `8cac511e-04f7-4070-9e58-f4bcdc976def` | N | N | N |
| `15745da0` | set_churn_same_hit | membership | Y | Y | 1 / 8 / 1 | 1 / 8 / 1 | `7fd03420-dfab-4af7-a96c-bed52d334eb6` `5617d2c7-35ce-4706-9ba7-38a56967ca4c` | `a069f97e-5512-440f-a096-2d7a5726634f` `2eaf89f2-4048-4700-8c45-11f1ae3f38ee` | Y | N | N |
| `19b5f2b3` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `b064d4c3-a9b3-4729-96a0-fc4c6b0d562a` `b7d05153-a974-48d3-84e5-80cc4362e6f9` | `b920d9e4-5ba5-40bf-8f3a-67cab46b290c` `2ff201dd-3fef-4dfb-9172-df61eb01bfde` | Y | N | N |
| `1e043500` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `642af159-8dd9-4854-8a73-c5815e8809b7` `1c6be83d-2a44-4c02-8d12-dee5b15058c4` `2ad0b833-9294-4ad6-b72a-4523f499215f` `3cd40ab8-2a27-40ff-b699-d61769a03dd4` | `8f232afa-9f26-487c-973a-8167fcb3cd61` `dc6a0202-87c0-4184-b360-6a5671a82bfb` `6cc3bc37-3af1-4901-868d-3165a153ee6e` `afc0ae86-9a6c-4b54-a549-f889a7657682` | N | N | N |
| `1faac195` | set_churn_same_hit | membership | Y | Y | 1 / 3 / 1 | 1 / 3 / 1 | `2a326e23-a080-4e84-8515-b33bc8b33425` `6ae3fd07-0af2-4331-b4bd-ab098d7bd41f` | `8231e531-c393-43f2-9aa9-5a54ba0a0bb4` `d0be96ad-34e4-416b-8832-07bd9ce214bd` | N | N | N |
| `2318644b` | set_churn_same_hit | membership | Y | Y | 1 / 8 / 8 | 1 / 1 / 1 | `3036c0df-5e14-4ebc-989d-1a22353dd2a5` `8bce6b45-18d5-4016-bfae-50b147b2e6b1` `c503f696-b479-428d-96ec-e8da061222a4` | `2aeef3fc-1ad1-4b7a-b7eb-c6d09acece4f` `0a75b724-14eb-445f-b040-67f0235dc504` `dcc7b1ad-43b5-458c-b1c2-ba07451cb7a3` | Y | Y | Y |
| `25e5aa4f` | set_churn_same_hit | membership | Y | Y | 3 / 16 / 10 | 3 / 9 / 3 | `9e6081cb-2304-4551-a5dc-a98c8dc3dac2` `5eda0f10-bcd8-428a-af1e-6b7906371aba` `69aa540f-bf7b-4a76-b502-4208673d20ea` `6d288529-6b7b-44f5-985d-ffcf24de34f2` | `a8c3960f-7478-4050-bc04-b50e64805a35` `eaa7bc17-3c27-4d08-9974-e0894b32e601` `aeb3924b-60fd-46b4-a94e-e25a4b2437fa` `75ff90d7-6766-43cc-8b88-44ef6f14fcb1` | Y | Y | Y |
| `28dc39ac` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `4c290282-4776-4399-aea6-8f00198acf57` | `a84309c2-b6c9-41d5-aba4-393d42468bba` | Y | Y | Y |
| `2e6d26dc` | set_churn_same_hit | membership | Y | Y | 3 / 1 / 1 | 3 / 3 / 3 | `8753a1e8-316b-4e83-be86-6fd57bf0bf2b` `6b1f9a9e-5af5-471b-b2b4-4568a5f8e55a` | `a5b84dc9-13bb-4339-b9b8-c71907f2a0cd` `74468fa5-0628-4689-9561-d604455e3cab` | N | N | N |
| `311778f1` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `1ed9cca2-7b39-43a7-b0ee-2574efb2c0d0` `674a8e15-d61b-46e8-ab74-e2fd085a5a41` | `3186052c-5c1a-4826-8bc7-bf807e522b1d` `3fd69290-0c06-45b7-a79f-07e36f2243bd` | N | N | N |
| `36580ce8` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `a2cd5a4b-83d3-484f-9b9b-e85432436e46` `1f8b3b4d-df41-46ed-b67a-c7790fe5540d` `aa9e131a-2648-4513-83ae-ecd960bece96` | `ce53e575-bf5e-4b75-9735-b0ee2d24eb37` `498a177b-d84c-4908-b866-969402e61f8b` `dea3af2c-ecf7-4013-8c18-57c4a8e81489` | N | N | N |
| `36b9f61e` | set_churn_same_hit | membership | Y | Y | 1 / 3 / 3 | 1 / 1 / 1 | `791359f2-9b7a-4213-a0d7-84d6939843e2` `7b1cbed8-f363-4771-a9e9-f61ac758693e` | `1728ef3f-f7a2-4351-92df-c34aa019d411` `7d5cd649-4dbe-4bc3-960e-7314aa945431` | Y | Y | Y |
| `37d43f65` | set_churn_same_hit | membership | Y | Y | 2 / 10 / 10 | 2 / 3 / 3 | `a4cba5ee-8ae7-4e64-a318-9218ecfb3bbb` | `c741ca40-e65a-43f9-9ac3-469d808052e4` | Y | N | N |
| `3a704032` | set_churn_same_hit | membership | Y | Y | 1 / 3 / 3 | 1 / 12 / — | `06a10689-b848-4d8f-8e42-f2265b13c30e` `a418dd5a-4b93-4b07-90cb-05f32418caf1` | `387efc11-5d61-405d-8aed-c6d1556b82f2` `119e6175-fd48-4dad-bbaf-4fdbfa26fd70` | N | N | N |
| `3b6f954b` | set_churn_same_hit | membership | N | N | 17 / 15 / 10 | 17 / 24 / — | `58d01df6-698b-4976-87ed-8879f360a37b` `8705be5e-6ce7-435c-996e-463ffceffda9` `289926fb-33a2-4a3b-899a-6c15ed5e0dc7` | `bc4a7f5a-a246-45c9-9cb0-85dcd1dc03f4` `5d3026bf-d403-473a-8502-eaea5694d8f4` `36c61286-85f8-406e-9213-0b03e79f2308` | N | N | N |
| `3f1e9474` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `32f1a283-4abc-41e5-9f30-0edb96796757` `1ff7cdec-ce2f-4235-8caa-318bceef6e8c` `f326bae8-0c5c-4dfd-9d9c-7ae58b7d160e` | `01190b28-c759-4878-a5cd-eb4e1cdb14e1` `2d5746d1-8e33-40d6-85d7-4ef58b0b56e5` `e21fd0d6-98b7-48f3-8ec7-64b21d75b00d` | N | N | N |
| `4100d0a0` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `13d29a82-1c4f-49a7-80e8-3c16e3ff2e91` `463a41e7-bdc1-4d20-944b-fd7b13eb931f` `9755a9b5-8e3b-4e45-a1f0-0b63144a6929` | `d74b8b52-068f-4fee-a902-93e6e8064d12` `8cc86a3d-f4e5-47c5-82c1-b7c8bb022f85` `93a1284f-dce2-4fcc-95ec-10df6024bb8f` | N | N | N |
| `46a3abf7` | set_churn_same_hit | membership | N | N | 9 / 7 / 7 | 9 / 9 / 9 | `e9c1d533-0ec5-4cb0-a3bb-e4b99341c978` `b878a596-32ba-40ae-866a-79d1030073b2` `e8e20a72-91d4-4bb2-899b-172b1921fb2a` `42ed4cea-2431-4ba4-96f1-9d1b1a1df094` | `2b63d610-a1a2-44ff-a5fd-bb59cb10a4df` `211c6587-7589-4caf-b445-2214f6450ee8` `4b4ecd71-853f-4f85-8b64-617853fe7193` `7266492b-97b2-4885-aeec-4204dd4dab71` | N | N | N |
| `4fd1909e` | set_churn_same_hit | membership | Y | Y | 1 / 5 / 2 | 1 / 4 / 1 | `6807ad36-1ba8-4d92-b990-7a59f061bae2` `ef434757-1f91-4714-8198-7ae24565ea6a` | `99dba9ea-ad8b-453a-9a22-9b91b3f2afad` `a86484fc-6730-452d-a435-50775522a5e2` | N | N | N |
| `51a45a95` | set_churn_same_hit | membership | Y | Y | 1 / 6 / 1 | 1 / 6 / 1 | `eccc02c3-b4ce-496c-8e24-a45b01377f73` `004ba490-7d8b-433a-bac7-6a8dcf7b6799` | `a9dd65d9-8c56-4f73-8fba-6820e0f48b55` `a80fd79f-5514-422f-a549-7aba42bc82b4` | N | N | N |
| `58bf7951` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `8f623fcb-06a3-44cc-a020-c067140b5f6e` `93c3d4f8-1f44-4e29-929c-25832316ff5c` | `b2ad6ffa-8725-4dad-ad58-72dc623ec778` `768f41e5-485d-4f0a-ae3e-239ebdcaf667` | N | N | N |
| `60d45044` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `59d6c231-6261-46ef-80cb-ff9e23324039` `cb7e2417-8d0a-4877-b152-6f51350abad7` `8db44465-f666-478a-b7a2-c32cc49f90f5` `a840d74c-20a7-45c7-81d8-cdab67ee52cb` | `5b1dd224-f252-463b-ada3-2ee53660fca0` `c8fe6bf7-3a11-4009-9c65-3cd443e81822` `0c27f3bd-d446-446f-9d63-da14551d86cf` `5654bd0e-d2ca-4aa5-9725-305b62dd6bd7` | N | N | N |
| `6ade9755` | set_churn_same_hit | membership | N | N | 30 / 41 / — | 30 / 36 / — | `07bbddd3-f9d5-4d54-9188-9abcf2935c00` `1c1f01ed-8cbd-466a-871c-f425368f0fc8` `861acf9f-368a-405d-90be-b45a13c2faa7` `3c20c977-1cc7-4af6-9e9b-298485f70fe2` `c6629231-9a49-4130-a1b9-9f7f76268ad0` | `206f9d55-a2c2-4772-980f-77379e5ef08c` `53bbdf3d-5bc1-4c10-8f13-5f530a711d6b` `03fd29cb-6b1d-4ac4-b4fa-a5837368931b` `ddec04a0-c2c3-4836-b013-17a0b1af1282` `1e2b0aad-5b38-44a7-a957-07b410e7f37c` | N | N | N |
| `6cb6f249` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `1818989b-46d4-45a2-a989-6d42527adac7` `02a12cbc-0339-42f9-8499-45f33e927ec5` | `0de9698e-f802-4c5c-97f2-421122f14e84` `27adec14-ec9b-43fd-9502-cb7c73ee1f24` | Y | Y | Y |
| `6d550036` | set_churn_same_hit | membership | N | N | 15 / 7 / 7 | 15 / 15 / — | `729af6df-f29d-4b55-9626-f60ce8e115a7` `85bfbdcd-154e-4828-b568-af63d7e4f815` `cebaae75-cf4b-4eca-a6f4-f8962bceff38` `7df76823-6f49-42fb-8b78-0ca407780f3f` | `99f665ce-3cd9-47c1-a2f9-fc9a3e4dd0da` `0513e0a7-ae11-4605-8070-5f3b05862b6f` `eb202702-26d5-44cc-84ae-274b096f28a3` `9e59ae6c-548f-4305-bcfb-9bd39023d81d` | N | N | N |
| `7527f7e2` | set_churn_same_hit | membership | Y | Y | 1 / 10 / 10 | 1 / 1 / 1 | `fd8cfcb4-0105-4741-aec0-a29b4b3c202c` `ae37fe64-eff9-412f-8987-2c47074306c8` `789a7e03-a225-449b-9622-2bad3bd689b9` | `d431e161-50d2-4544-8224-09f366ec52e2` `6d331484-fcb3-4acd-b883-11be9b8e2fc0` `d5d3b171-0b84-449a-a6c8-652b638bc15f` | Y | Y | Y |
| `75499fd8` | set_churn_same_hit | membership | N | N | 14 / 6 / 6 | 14 / 12 / — | `2dd2e73f-c791-49ba-9312-d11850faae3a` `a9904b42-797d-4398-8b4a-2378e31f19eb` `bd2c3879-7bb4-44bf-852d-c0d68fa800a3` `9db4118b-fc76-4c86-8777-f59165166545` | `37a5c63c-22c3-4de9-9fb8-cce9f449fd57` `50745b16-a6ce-46c6-8b5f-dac941a4af7e` `5d34e700-5038-47b0-8705-302ec427b9ae` `92daf281-1b33-4b43-b093-bb8aa0556d54` | N | N | N |
| `76d63226` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `03dade5f-90b4-431f-85d2-efe4c3a457db` `9cf3064f-6459-44e3-9da0-722754017691` | `0c04acba-4697-4bba-b53b-f1b742c953a9` `dd1b6608-d469-4fa8-bf6b-ebcacf4ca93a` | Y | N | N |
| `80ec1f4f` | set_churn_same_hit | membership | N | N | 32 / 8 / 8 | 32 / 11 / — | `32e3ff3e-dfe7-4f6d-afe0-b43523e1e854` `c7797062-141f-47eb-a409-110ab92bf018` | `097017ec-555b-4805-92b1-f61ec86d96f3` `35d290b9-acef-4779-babb-15b7487d48a4` | N | N | N |
| `853b0a1d` | set_churn_same_hit | membership | Y | Y | 4 / 123 / — | 4 / 4 / 4 | `bdc3341f-b91c-46b9-a56c-afe511ad6de1` `f74bd90d-2d6d-4546-8051-5a9e985798fc` `bd34c1a0-7a1a-40e4-b6ed-883af27fd66a` | `de143915-6074-4f7c-b12a-592f2a1b962b` `9f29f156-6eec-4984-843f-0cc48cca4c3a` `ca18cf25-c5a9-4e4f-911a-54fb3acfa247` | Y | Y | Y |
| `8550ddae` | set_churn_same_hit | membership | Y | Y | 2 / 1 / 1 | 2 / 2 / 2 | `fe2b516f-f30e-459b-9a1d-340da28a9dc7` `ff69457f-e4ee-4f08-a171-2b63f52f2d1b` | `870112c0-0251-404b-be01-d4a57429f4a4` `cb2f5bd0-cc9b-4e5b-a9fa-bdd5b6d21bac` | Y | N | N |
| `86b68151` | set_churn_same_hit | membership | Y | Y | 1 / 28 / — | 1 / 1 / 1 | `a06dba9a-3a32-4830-99a2-a80d0bdc26c9` `356e6454-8edf-409c-9958-80106213ed1a` | `a6e6da0a-58d9-4f40-8ed5-6f8ce650ee14` `2bb6e978-f7ca-4b82-9dbd-f99e86ab7779` | Y | N | N |
| `88432d0a` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `6c013037-1d87-4002-b882-d37d512da053` `1bc2c3f2-447c-4e31-b819-163475b51ca5` `ba07f414-61a5-477b-a68b-f0b63ad74851` | `cd5da390-de83-4661-9639-4d5dc6af4d80` `86b7cc02-aae0-4697-b1a7-709d88a3be65` `48b4d070-e7d7-4aab-a15b-c3c2661d934c` | N | N | N |
| `8a137a7f` | set_churn_same_hit | order_only | N | N | 116 / 6 / 6 | 116 / 136 / — | — | — | N | N | N |
| `8e9d538c` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `108cd417-72bc-4c85-bda1-49a38a44d287` `804631bd-4483-4adf-9d53-4582ca5c00a5` | `3cb0e2f8-0718-440d-99ee-fdb025bb2f47` `2389d373-bbe4-49a3-a2ec-f98ad48c298e` | N | N | N |
| `8ebdbe50` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `cabaa76e-2787-4283-92ba-4df577d0bb02` | `0d2abe5c-abfc-4e06-bba8-db2f4bca1cc9` | N | N | N |
| `94f70d80` | set_churn_same_hit | membership | Y | Y | 3 / 16 / — | 3 / 3 / 3 | `8dd1624f-db9a-4169-b7f1-a3047bed078e` `60543202-2136-45fa-bd54-d4789350c741` `3b9ab4a4-5512-4f48-827b-84e607525200` `b6283632-af08-4530-b972-f27a51baf099` `aaa4c228-ef4f-435d-9d0e-db5a793de5fb` | `abf0792b-a8d1-4e89-becb-01e1a42c9c19` `ca75db01-95cf-4b14-b749-1004faa61a64` `a5ef7c7c-3a69-4bd2-8d92-ab798b0267b1` `c61b2df4-4624-4c5b-9f0a-dd999c51cba1` `41c3209f-dc32-4c9d-8b6c-caa7661d366e` | Y | Y | Y |
| `95bcc1c8` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `2c0d83d3-7b6a-4acc-b781-b29cd063d0b7` `f8202112-d5db-459f-bd51-779fcf68d657` `23b5fb41-027f-4970-aa79-271ca112a082` `d78f3523-fddd-4cdb-890e-75e2a50e9fdf` | `2ae566e3-6595-4b14-a60b-ea73d69eb5fb` `c9cc8319-2c14-4f52-bf0b-6a28ee1055e1` `0b08d7e9-0bc6-4764-8a1a-89ee475ded44` `7fa260e7-21db-43c0-a165-b5587d3ad1b4` | N | N | N |
| `a06e4cfe` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `d3eb69aa-7c66-4235-811f-d87b8e96b896` `b8afe489-931c-4958-9613-cbb87071322e` `c4935618-f1a5-4554-8ec0-05067764c471` | `1a3419ee-530d-479c-a0b7-ded0a029b5a1` `b1610f6b-eea1-4f69-84f9-8899585db08c` `8db1c1c4-d6a3-4bf1-a380-ba1ccb76d931` | N | N | N |
| `a82c026e` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `ff38b282-7966-4399-936f-4272448f12e9` `7ed583ff-b9c3-466a-ace5-4cffc9b470c8` | `71a66ea7-b1c6-41b4-aa37-68868ef21c78` `ddc53522-349c-46df-89c4-d2b529aed7e6` | N | N | N |
| `aae3761f` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `ba600556-cf35-4f67-8fce-27b98c52d315` `32629dd6-8259-412b-b4c6-e24013fbd895` | `1ed18b4b-d80c-4fe2-9e11-fb5adcfd271f` `dee2c6e9-083a-41f1-9da6-979b81416e1b` | Y | N | N |
| `ad7109d1` | set_churn_same_hit | membership | Y | Y | 4 / 3 / 3 | 4 / 4 / 4 | `031f69a1-63b9-4c17-927c-ca270852a3fb` `264183fb-bc3b-4aa5-8d7a-a32724bb9794` `c67a8660-bf04-4bb9-9ca9-eff25c60548d` `bf33bce0-11bc-49f8-9e09-caa853936aab` | `e98c7bcf-2ef6-46ab-8b22-44853da0f679` `26ceec8f-548e-48d6-9f26-6d00db82947b` `02040415-401e-4456-9cda-e6c091434038` `11542095-325f-4f77-b182-e8488b4561a5` | N | N | N |
| `b320f3f8` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `44e17af0-d2f8-41f2-9b2f-d7f58056e577` `c1feefd2-b2d2-41d2-b199-551dfeb3088d` | `43ecd580-8dfa-4e66-9af0-ba371f200e28` `6125b53c-cd03-442f-a68a-129336d16d62` | N | N | N |
| `b5ef892d` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `6bfdff38-aa6d-4749-a3c7-de823c4e2024` | `007a9a79-485d-4cb2-9dd5-f449ddcd3b4e` | N | N | N |
| `bc8a6e93` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `b6aac9bf-19dd-410c-bba6-859b29ed5ab4` `27416807-2c01-46f5-a770-8dd2dae9491f` `d5a95068-59f6-476c-8091-016764252cf6` | `3cdbcfc4-0a84-4e39-8736-a0a79fc37663` `5b54de97-f653-4dc9-aaf2-ddd8c48fbc89` `7cdca69e-3145-4472-a906-acd2df8a3b00` | N | N | N |
| `c14c00dd` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `c91ff762-d97b-4d05-9446-edb542551462` `254e9943-85fc-4e06-bd3d-76e438aacbad` `794dcea7-b835-4ae8-9a24-dfe448db6770` | `52bef092-2d08-41d6-88d2-6bd495b95537` `29317b80-d32c-41ef-afea-66a7b6e52201` `2ec02e3f-e19c-42f7-aed9-996b3d775bd9` | N | N | N |
| `c19f7a0b` | set_churn_same_hit | membership | Y | Y | 1 / 4 / 4 | 1 / 1 / 1 | `7d66aabb-c620-4166-a8bd-fab669a2e5d8` `96684438-6c79-4494-920f-683ff892493d` `0158c001-656c-4ecc-8781-48f556fe6182` | `d9d55b3c-32ec-4aa7-b9e7-ed8636e69244` `f67fa1b3-7875-4b7e-adbc-8b4f967d5a4a` `88181be4-8859-48f2-8d6e-e896c9b5a3ad` | N | N | N |
| `c8c3f81d` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `606b989d-8391-4667-bc04-a99e5b202cea` `e9bb25e2-03fa-4b61-a1e7-b5d137e015a4` | `24f7058f-000c-48ec-be2e-274c93e5ed43` `41dfd82c-becb-4d3b-a856-6e58faae70dc` | N | N | N |
| `c960da58` | set_churn_same_hit | membership | Y | Y | 3 / 2 / 2 | 3 / 3 / 3 | `06c6083e-ca05-46a9-a4ca-f37f55e49d6d` | `a0a2bebf-51a2-4b80-9546-ca9b94a523f0` | N | N | N |
| `caf9ead2` | set_churn_same_hit | membership | N | N | 76 / 12 / 9 | 76 / 137 / — | `44f1252e-1bd6-4635-b2bf-2c6000cc9f65` `5a3d1dd0-9a53-473e-be01-db1113d1f3e4` | `82096b44-5021-40f7-a799-60b78b89e69c` `76f6ef66-2a15-4b43-9a05-1747cc3564c6` | N | N | N |
| `ccb36322` | set_churn_same_hit | membership | N | N | 18 / 35 / — | 18 / 38 / — | `c5e90a63-42e8-4946-a045-31e46189d3cf` `877dffa8-d50c-428d-8661-d88e2d88ba3b` `d642b848-4f15-4cab-84d7-a272cd660a2a` | `cf6ba605-a58b-4e89-9b5a-2a0a622f651d` `70cd5ca1-85eb-410c-bd2b-7982499b2e96` `9a8a10ec-e54a-411c-ac47-6bf8fd9404e1` | N | N | N |
| `d23cf73b` | set_churn_same_hit | membership | Y | Y | 2 / 3 / 3 | 2 / 2 / 2 | `10249aa7-018e-42d5-8a61-c858fabd4b40` `8d2e9862-b0c8-476d-a2a9-c96928de1989` | `fc296c3b-4cbc-40ea-9eb1-63bba837b06f` `f89cd835-faf1-4c04-b706-487443223b0d` | N | N | N |
| `d682f1a2` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `4ff0d17b-aee6-43c5-8233-00c5911732a2` `85e20925-4c72-4c56-a9a2-86aaf749b150` `a5ed809f-7118-4c6a-9fa8-639ce6948804` | `7b4ca654-1201-4356-9421-a241913bf348` `60c462b7-fa7d-4390-8da6-3c6f4f0336db` `fc767834-8470-4442-8499-09b81a4588c9` | N | N | N |
| `dccbc061` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `fb8fd8b6-1b34-494c-ad85-7042d3120a72` `6608791e-21ab-42bf-9800-f3a1de076f77` `24a86c8e-7cea-47c2-b15f-4b35c9287183` `604c58e8-968a-49e2-8fe4-bb0b3d3eca09` | `4965c9a6-1646-4867-800d-a142b6394cb0` `5a48d17d-1111-4758-b6d4-4573d46edb0a` `1594f335-4c69-4529-98bb-0163ce32b4ab` `dc4443bd-aae6-4548-bce8-b67ee357c530` | N | N | N |
| `dd2973ad` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `093a2ee5-b0bf-44f4-9e85-7c682d8fdd19` `af04187d-6ced-4e27-baef-a23eb8711984` `7e3f66ac-4c10-4220-bb75-950ff8d49868` `23133f74-a42a-40b0-97a6-871faf874915` | `807983fd-fa91-4749-9f8d-7ca9e0342895` `482f0000-9da0-4e82-bfbc-2515a952f211` `b2593333-dae9-4fe6-a205-1b4a3837474e` `46197e27-f2e3-4112-89f7-f922dca4d9d4` | N | N | N |
| `e01b8e2f` | set_churn_same_hit | membership | Y | Y | 5 / 6 / 3 | 5 / 8 / 5 | `cef2dab3-41e2-4e8e-aa98-43f5bb49934d` `71dc8fa3-5d83-4812-b193-74bc72b42880` `b0a17988-457a-421a-a89c-821b471d7ba1` | `648f5638-2e09-44b9-98a0-0fa965f55c16` `d80d00ce-ab8f-4ef1-bc79-ecf2f9fb151e` `f983f9f4-125c-47c7-b4d3-67b7df04031d` | N | N | N |
| `e47becba` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `b4965936-9c77-4950-a3c7-18aae34f2242` `2bb26f9a-6450-44f9-b73e-904011e16440` `e819ba44-8047-4d77-8b3c-f1da5ffae13d` `91b0755e-0547-4c71-ab41-3f8ada669f1b` | `0c64b4f8-d518-449a-9866-7959b53dfce4` `cf14f8d0-b603-44fd-8c60-ce059bdf5d5c` `066e796c-b05e-41c7-96c5-770cce5be343` `48171fa6-b66d-4114-a7cc-acba9d7265b4` | N | N | N |
| `e831120c` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `b50cf3c4-8bcf-40a0-933c-1b85408a823e` `e4efefdb-aacd-4044-bd46-54e63c3219c9` `4d7a096b-4f4d-4a38-810b-80672a350bc7` | `3ef7a322-b0df-41fe-9e03-f41a7465d784` `a1bc4510-820e-4e33-add7-0ce8f4241fae` `54da26f4-bc08-41e5-b52e-a8548bcf363e` | N | N | N |
| `ec81a493` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `992906d8-d947-4789-b039-c82171783686` `bc7e5498-e0b0-4c9c-877a-7fea17949eab` | `82cbea6e-b6d7-4bca-b452-d6f5e857f443` `50a0a9c5-bad9-48a7-8862-ec8d8cf073b7` | N | N | N |
| `f4f1d8a4` | set_churn_same_hit | membership | Y | Y | 3 / 1 / 1 | 3 / 3 / 3 | `18af54fc-c6de-4186-ae7a-93dd229d4943` `23002444-1a36-4518-bc52-fc7b572461de` `62e55dd5-da4b-46e0-af5e-43c16909bb5b` | `c8bb7f40-0f82-4d4b-b248-923001fe989c` `eb663780-ec0a-4c3d-81ec-c9e6c860ce64` `fe6430da-c1c4-4c7a-8295-00c5a9d95e57` | N | N | N |
| `f8c5f88b` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 1 | 2 / 3 / 2 | `ab96b5d5-b76f-4ddf-8538-9d0636b0f1ed` `2777e418-e556-4c4c-9a86-aed81602ec7e` `d76033f7-68f8-4793-ba1c-76f3044e1b45` | `d472196d-308e-43bf-8702-fc2e9c412aa7` `2a52ac49-1a0a-4b92-82b9-6a1eec5fad28` `13a4e9a6-4888-416c-b614-f398c7b3fb35` | N | N | N |
| `gpt4_15e38248` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `80e9d703-987f-4417-b25a-5c2c0264959e` `e1d89153-7ee7-46ea-bab1-5c8046772040` `cb92d323-ff93-4c13-97f9-6a833fe80f95` `9f87d862-f558-46e4-8405-c66cb489f7d5` | `740c3996-1a7f-4791-b1a3-72532037815c` `cbb51284-3c96-499c-938c-d5573e2d9943` `79e057f7-c4bc-4b1f-8690-bac28133596d` `7eb374fe-2f50-4f80-91c2-bfac1b703feb` | Y | Y | Y |
| `gpt4_2ba83207` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `5a0526dd-d6f1-4082-8c97-7b98164e240e` `f0816e4f-b866-4b48-87a3-d1a12989c448` `9eaf0c5c-a30c-422c-a30b-e69cf61203c7` | `11838eef-0830-43d6-981d-68d178cf30bd` `941964c1-c54d-4078-8e6c-498057155371` `0df17e1d-7929-405f-981e-f5f481f09f5c` | Y | Y | Y |
| `gpt4_2f8be40d` | set_churn_same_hit | membership | N | N | 10 / 12 / — | 10 / 10 / 10 | `3dee1eed-4061-4aa2-80c6-a4c6d064231a` `6bdf16d8-72ff-4449-8d2b-f083aa8c670d` | `b507de93-65c6-4177-bd1e-9f9d0dfa76e0` `a8cf9e50-3be5-435a-b890-9484339a81e1` | N | N | N |
| `gpt4_5501fe77` | set_churn_same_hit | membership | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 | `c7328c4b-5170-407a-88a4-81747b305996` `a6545fc0-20d3-4137-923b-6bcb000e3fc4` `a4fedf85-4ceb-41af-befe-c35dba96fa5a` | `0ce5ba70-4e1f-49ad-93cf-7f728601c145` `4a38a898-e062-40a0-af4a-85d996a413a3` `b56c3924-60d2-4944-9474-62cca01b4455` | Y | Y | Y |
| `gpt4_59c863d7` | set_churn_same_hit | membership | Y | Y | 3 / 1 / 1 | 3 / 3 / 3 | `4bd8b877-b42a-4e2a-b796-cc64bd2bf96c` `0275d175-e89b-4d9d-bca1-e70402d6f70c` | `c3df8d89-a93c-43ac-b910-02fd054a8b3c` `4da002d3-2cd3-4651-9159-5955d555d63d` | N | N | N |
| `gpt4_a56e767c` | set_churn_same_hit | membership | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 | `3ac265ad-6560-46a7-b9df-121b39843c4b` `ddc777c6-8076-4c29-bfc7-311d5f714e9a` `ffd095f7-26af-4eae-bf35-663654f79b64` `fd030a1d-e916-40ab-b3c2-fa1e64f76a25` | `d7661f4a-302f-48b1-9130-71bd780a8be7` `0f4a537c-661c-4a5c-a2c1-22f413acd8ae` `8e6e30df-3138-4861-adb3-cd5b015658aa` `bb0f6307-394a-48f8-8c26-8e8b23361941` | Y | Y | Y |
| `gpt4_d12ceb0e` | set_churn_same_hit | membership | Y | Y | 2 / 2 / 2 | 2 / 2 / 2 | `1f1aa392-4f0a-438f-92c8-81984cfdd9f2` `3ad5c6a8-ab86-4ecc-b168-0a04067cbe86` `0c08701a-22ea-43a4-94f9-32ee518dfd9e` | `ab26ffb0-d49b-4556-b37a-76c2a4223fea` `04c2e94c-af7d-4022-b042-7d235f493075` `84cbe369-7ca7-4c06-b21d-f34019317205` | N | N | N |
| `gpt4_f2262a51` | set_churn_same_hit | membership | N | N | 11 / 7 / 7 | 11 / 14 / — | `7cdb2338-effe-4975-ac76-110dcfc34c7c` `bbed9109-2d1e-492b-a518-f97e0c6bcffc` `efbd478e-19bf-479b-9f8e-d3141880c9d9` `1237926f-b2bb-4efa-af66-472cb70b5cbb` | `3a934a04-bd84-441a-b1c8-b98a17cce707` `f7984a2b-d04e-41f6-b669-57cbcbf8d0a2` `3ac8d336-162a-4a51-ac43-56fb8b775378` `c5b0fd6d-a45e-4778-adf0-d978f9ae6d1d` | N | N | N |

### Within-question / same-slot conflicts

Inferred from delivered sets + fused ranks + selection_order, not from an objective decomposition (that receipt is NOT_REPLAYABLE).

| id | anc@5 | g21@5 | best fused/sel/final anc→g21 | displaced fused-head object_id | waist gold dropped |
| --- | --- | --- | --- | --- | --- |
| `2318644b` | Y | Y | 1 / 8 / 8 → 1 / 1 / 1 | `3036c0df-5e14-4ebc-989d-1a22353dd2a5` | `2aeef3fc-1ad1-4b7a-b7eb-c6d09acece4f (fused 10)` |
| `25e5aa4f` | Y | Y | 3 / 16 / 10 → 3 / 9 / 3 | `5eda0f10-bcd8-428a-af1e-6b7906371aba` | `eaa7bc17-3c27-4d08-9974-e0894b32e601 (fused 14)` `a8c3960f-7478-4050-bc04-b50e64805a35 (fused 11)` |
| `28dc39ac` | Y | Y | 1 / 2 / 2 → 1 / 1 / 1 | `4c290282-4776-4399-aea6-8f00198acf57` | `a84309c2-b6c9-41d5-aba4-393d42468bba (fused 10)` |
| `36b9f61e` | Y | Y | 1 / 3 / 3 → 1 / 1 / 1 | `791359f2-9b7a-4213-a0d7-84d6939843e2` | `7d5cd649-4dbe-4bc3-960e-7314aa945431 (fused 9)` `1728ef3f-f7a2-4351-92df-c34aa019d411 (fused 7)` |
| `6cb6f249` | Y | Y | 1 / 1 / 1 → 1 / 1 / 1 | `02a12cbc-0339-42f9-8499-45f33e927ec5` | `27adec14-ec9b-43fd-9502-cb7c73ee1f24 (fused 155)` |
| `7527f7e2` | Y | Y | 1 / 10 / 10 → 1 / 1 / 1 | `fd8cfcb4-0105-4741-aec0-a29b4b3c202c` | `d431e161-50d2-4544-8224-09f366ec52e2 (fused 13)` |
| `853b0a1d` | Y | Y | 4 / 123 / — → 4 / 4 / 4 | `f74bd90d-2d6d-4546-8051-5a9e985798fc` | `de143915-6074-4f7c-b12a-592f2a1b962b (fused 6)` |
| `94f70d80` | Y | Y | 3 / 16 / — → 3 / 3 / 3 | `3b9ab4a4-5512-4f48-827b-84e607525200` | `abf0792b-a8d1-4e89-becb-01e1a42c9c19 (fused 15)` |
| `gpt4_15e38248` | Y | Y | 1 / 2 / 2 → 1 / 1 / 1 | `cb92d323-ff93-4c13-97f9-6a833fe80f95` | `740c3996-1a7f-4791-b1a3-72532037815c (fused 43)` `7eb374fe-2f50-4f80-91c2-bfac1b703feb (fused 49)` `79e057f7-c4bc-4b1f-8690-bac28133596d (fused 57)` `cbb51284-3c96-499c-938c-d5573e2d9943 (fused 60)` |
| `gpt4_2ba83207` | Y | Y | 1 / 1 / 1 → 1 / 1 / 1 | `f0816e4f-b866-4b48-87a3-d1a12989c448` | `11838eef-0830-43d6-981d-68d178cf30bd (fused 7)` |
| `gpt4_5501fe77` | Y | Y | 1 / 2 / 2 → 1 / 1 / 1 | `c7328c4b-5170-407a-88a4-81747b305996` `a4fedf85-4ceb-41af-befe-c35dba96fa5a` | `0ce5ba70-4e1f-49ad-93cf-7f728601c145 (fused 7)` `b56c3924-60d2-4944-9474-62cca01b4455 (fused 8)` |
| `gpt4_a56e767c` | Y | Y | 1 / 1 / 1 → 1 / 1 / 1 | `3ac265ad-6560-46a7-b9df-121b39843c4b` | `8e6e30df-3138-4861-adb3-cd5b015658aa (fused 11)` |

Within-question conflict n=12. Same-slot gold conflict n=12. Fused-head displaced in ancestor n=23: `001be529` `15745da0` `19b5f2b3` `2318644b` `25e5aa4f` `28dc39ac` `36b9f61e` `37d43f65` `6b168ec8` `6cb6f249` `6f9b354f` `726462e0` `7527f7e2` `76d63226` `853b0a1d` `8550ddae` `86b68151` `94f70d80` `aae3761f` `gpt4_15e38248` `gpt4_2ba83207` `gpt4_5501fe77` `gpt4_a56e767c`.

The +4 head-recovery questions are not in this conflict table: ancestor missed any@5, so no waist gold was in the delivered set. The 12 conflicts are any@5-stable hitchhikes: a fused-head gold was out of ancestor top-5 while a waist gold occupied a slot; G21 ranking-preserve admitted the fused-head and dropped that waist gold without flipping any@5.

## Bounded-refinement shape verdict

Candidate-independent shape under test: **quality may not displace fused-head (`fused_rank<=5`); quality may still compete below that head.** No protection-band constant is fitted. No numeric k is recommended from gold labels. No exact marginal-gain interval is claimed.

- Head-recovery ids and waist-loss ids disjoint: **yes**.
- Conflict-free scorable questions: **82/94**.
- Same-slot conflict n: **12**.
- Exact score/atom replay: **NOT_REPLAYABLE**.
- Order-level shape: **FALSIFIED**.

Replay of exact scores/atoms is NOT_REPLAYABLE because cover availability, candidate Values_v/atoms, per-step quality/cover/rho, and objective state were not captured. At order level, head-recovery (4: 001be529, 6b168ec8, 6f9b354f, 726462e0) and waist-loss (19: 21436231, 29f2956b, 2ce6a0f2, 3d86fd0a, 545bd2b5, 577d4d32, 58ef2f1c, 5d3d2817, 66f24dbb, 7024f17c, 86f00804, af8d2e46, b86304ba, c4a1ceb8, c5e8278d, d52b4f67, faba32e5, gpt4_7fce9456, gpt4_d84a3211) are disjoint. Within-question conflicts 12; same-slot gold conflicts 12. At least one question requires both protecting a fused-head gold and keeping a waist quality admittee of that slot, so simultaneous both-on-that-question is FALSIFIED. Conflict-free questions remain 82/94. The shape is not a production PASS.

This is not a production PASS. Dual-13 stays honest no-fix. Pin `3af4fd9` is not overwritten.

## Secondary E0 control (not the owner)

KPI any@5: ancestor E0 51/94 → G21 E0 48/94 (0 gained / 3 lost, net -3). Lost ids `86f00804` `d52b4f67` `gpt4_7fce9456`.

| class | n |
| --- | --- |
| unchanged_hit | 32 |
| unchanged_miss | 27 |
| head_recovered | 0 |
| waist_lost | 3 |
| other_gain | 0 |
| other_loss | 0 |
| set_churn_same_hit | 32 |

- **unchanged_hit** (32): `0862e8bf` `118b2229` `15745da0` `19b5f2b3` `1faac195` `2318644b` `36b9f61e` `37d43f65` `3f1e9474` `4100d0a0` `51a45a95` `58bf7951` `6cb6f249` `726462e0` `76d63226` `853b0a1d` `8550ddae` `8e9d538c` `a82c026e` `aae3761f` `b320f3f8` `b5ef892d` `c19f7a0b` `c960da58` `d682f1a2` `dccbc061` `ec81a493` `f4f1d8a4` `gpt4_15e38248` `gpt4_2ba83207` `gpt4_5501fe77` `gpt4_a56e767c`
- **unchanged_miss** (27): `0a995998` `1e043500` `29f2956b` `2ce6a0f2` `2e6d26dc` `3d86fd0a` `46a3abf7` `545bd2b5` `5d3d2817` `60d45044` `66f24dbb` `6b168ec8` `75499fd8` `80ec1f4f` `94f70d80` `95bcc1c8` `ad7109d1` `b86304ba` `c4a1ceb8` `c5e8278d` `c8c3f81d` `caf9ead2` `ccb36322` `e47becba` `f8c5f88b` `faba32e5` `gpt4_d12ceb0e`
- **head_recovered** (0): —
- **waist_lost** (3): `86f00804` `d52b4f67` `gpt4_7fce9456`
- **other_gain** (0): —
- **other_loss** (0): —
- **set_churn_same_hit** (32): `001be529` `21436231` `25e5aa4f` `28dc39ac` `311778f1` `36580ce8` `3a704032` `3b6f954b` `4fd1909e` `577d4d32` `58ef2f1c` `6ade9755` `6d550036` `6f9b354f` `7024f17c` `7527f7e2` `86b68151` `88432d0a` `8a137a7f` `8ebdbe50` `a06e4cfe` `af8d2e46` `bc8a6e93` `c14c00dd` `d23cf73b` `dd2973ad` `e01b8e2f` `e831120c` `gpt4_2f8be40d` `gpt4_59c863d7` `gpt4_d84a3211` `gpt4_f2262a51`

Flips and set churn:

| id | class | anc@5 | g21@5 | anc fused/sel/final | g21 fused/sel/final |
| --- | --- | --- | --- | --- | --- |
| `86f00804` | waist_lost | Y | N | 9 / 1 / 1 | 9 / 9 / 9 |
| `d52b4f67` | waist_lost | Y | N | 40 / 41 / — | 40 / 40 / — |
| `gpt4_7fce9456` | waist_lost | Y | N | 13 / 14 / — | 13 / 13 / — |
| `001be529` | set_churn_same_hit | Y | Y | 6 / 13 / 4 | 6 / 12 / 3 |
| `21436231` | set_churn_same_hit | N | N | 36 / 36 / — | 36 / 36 / — |
| `25e5aa4f` | set_churn_same_hit | Y | Y | 6 / 13 / 7 | 6 / 11 / 5 |
| `28dc39ac` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 |
| `311778f1` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 2 / 2 |
| `36580ce8` | set_churn_same_hit | Y | Y | 3 / 1 / 1 | 3 / 3 / 3 |
| `3a704032` | set_churn_same_hit | Y | Y | 1 / 3 / 3 | 1 / 11 / — |
| `3b6f954b` | set_churn_same_hit | N | N | 30 / 35 / — | 30 / 35 / — |
| `4fd1909e` | set_churn_same_hit | Y | Y | 1 / 6 / 3 | 1 / 4 / 1 |
| `577d4d32` | set_churn_same_hit | N | N | 26 / 26 / — | 26 / 26 / — |
| `58ef2f1c` | set_churn_same_hit | N | N | 8 / 9 / 9 | 8 / 8 / 8 |
| `6ade9755` | set_churn_same_hit | N | N | 47 / 51 / — | 47 / 51 / — |
| `6d550036` | set_churn_same_hit | N | N | 16 / 17 / — | 16 / 16 / — |
| `6f9b354f` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 |
| `7024f17c` | set_churn_same_hit | N | N | 29 / 29 / — | 29 / 29 / — |
| `7527f7e2` | set_churn_same_hit | N | N | 6 / 6 / 6 | 6 / 6 / 6 |
| `86b68151` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 |
| `88432d0a` | set_churn_same_hit | Y | Y | 1 / 1 / 1 | 1 / 1 / 1 |
| `8a137a7f` | set_churn_same_hit | N | N | 130 / 130 / — | 130 / 130 / — |
| `8ebdbe50` | set_churn_same_hit | Y | Y | 2 / 2 / 2 | 2 / 1 / 1 |
| `a06e4cfe` | set_churn_same_hit | Y | Y | 3 / 4 / 4 | 3 / 3 / 3 |
| `af8d2e46` | set_churn_same_hit | N | N | 14 / 15 / — | 14 / 14 / — |
| `bc8a6e93` | set_churn_same_hit | N | N | 16 / 17 / — | 16 / 16 / — |
| `c14c00dd` | set_churn_same_hit | Y | Y | 2 / 1 / 1 | 2 / 2 / 2 |
| `d23cf73b` | set_churn_same_hit | N | N | 5 / 7 / 7 | 5 / 6 / 6 |
| `dd2973ad` | set_churn_same_hit | Y | Y | 4 / 1 / 1 | 4 / 4 / 4 |
| `e01b8e2f` | set_churn_same_hit | N | N | 18 / 21 / — | 18 / 21 / — |
| `e831120c` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 |
| `gpt4_2f8be40d` | set_churn_same_hit | N | N | 13 / 13 / — | 13 / 13 / — |
| `gpt4_59c863d7` | set_churn_same_hit | Y | Y | 1 / 2 / 2 | 1 / 1 / 1 |
| `gpt4_d84a3211` | set_churn_same_hit | N | N | 41 / 41 / — | 41 / 41 / — |
| `gpt4_f2262a51` | set_churn_same_hit | N | N | 23 / 23 / — | 23 / 23 / — |
