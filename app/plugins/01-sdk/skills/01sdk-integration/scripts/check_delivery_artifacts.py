#!/usr/bin/env python3
"""Read-only ZIP/source comparison and known-QA-marker scan for Unity iOS delivery.
This does not verify a connected phone, signing, SDK ingestion or cold-start behavior.
"""
import argparse
import json
import mmap
from pathlib import Path, PurePosixPath
import plistlib
import stat
import zipfile

ROOTS={'Assets','Packages','ProjectSettings'}
DEFAULT_MARKERS=('DeviceIntegrationTestHarness','PartnerDeviceVerification',
 'CRYSTAL_SDK_DEVICE_TEST','CRYSTAL_PARTNER_VERIFY','__partnerQA',
 'CrystalPartnerCapture','CrystalPartnerNativeMetrics','whiteControlNative')
MACHO_MAGICS={bytes.fromhex(x) for x in ['cffaedfe','feedfacf','cefaedfe','feedface','cafebabe','bebafeca','cafebabf','bfbafeca']}

def safe_relative(value):
 p=PurePosixPath(value)
 return bool(value) and bool(p.parts) and '\\' not in value and not p.is_absolute() and '..' not in p.parts and ':' not in p.parts[0]

def archive_check(project,archive,excludes,markers):
 if not project or not project.is_dir():raise ValueError('A source project is required for ZIP verification')
 for root in ROOTS:
  if not (project/root).is_dir():raise ValueError('Incomplete source project')
 for item in excludes:
  if not safe_relative(item) or any(c in item for c in '*?[') or not (project/item).is_file():
   raise ValueError('Exclusions must name exact existing files')
 expected={p.relative_to(project).as_posix():p for root in ROOTS for p in (project/root).rglob('*')
           if p.is_file() and p.name!='.DS_Store' and p.relative_to(project).as_posix() not in excludes}
 errors=[];findings=[]
 with zipfile.ZipFile(archive) as z:
  infos=[i for i in z.infolist() if not i.is_dir()]
  names=[i.filename for i in infos]
  if len(names)!=len(set(names)):errors.append({'code':'duplicate_archive_entries'})
  unsafe=[n for n in names if not safe_relative(n)]
  if unsafe: return {'checked':True,'passed':False,'errors':[{'code':'unsafe_archive_paths','paths':unsafe[:20]}]}
  links=[i.filename for i in infos if stat.S_ISLNK(i.external_attr>>16)]
  if links:errors.append({'code':'archive_symlinks_require_review','paths':links[:20]})
  first={PurePosixPath(n).parts[0] for n in names}
  if first and first<=ROOTS:prefix=''
  elif len(first)==1:prefix=next(iter(first))+'/'
  else:return {'checked':True,'passed':False,'errors':[{'code':'unexpected_archive_layout'}]}
  actual={i.filename[len(prefix):]:i for i in infos}
  if not actual:errors.append({'code':'empty_archive'})
  missing=sorted(expected.keys()-actual.keys());extra=sorted(actual.keys()-expected.keys())
  if missing:errors.append({'code':'missing_files','count':len(missing),'paths':missing[:20]})
  if extra:errors.append({'code':'unexpected_files','count':len(extra),'paths':extra[:20]})
  crc=z.testzip()
  if crc:errors.append({'code':'crc_failure','path':crc})
  mismatches=[]
  for rel,info in actual.items():
   data=z.read(info)
   if rel in expected and data!=expected[rel].read_bytes():mismatches.append(rel)
   hits=[m for m in markers if m.encode() in data]
   if hits:findings.append({'path':rel,'markers':hits})
  if mismatches:errors.append({'code':'source_mismatch','count':len(mismatches),'paths':mismatches[:20]})
  if findings:errors.append({'code':'known_qa_markers_in_archive','findings':findings})
 return {'checked':True,'passed':not errors,'file_count':len(infos),'source_file_count':len(expected),
         'crc_passed':crc is None,'excluded_files':sorted(excludes),'errors':errors}

def app_check(app,markers):
 if not app.is_dir() or app.suffix!='.app':raise ValueError('Expected an app directory')
 errors=[];findings=[]
 try:
  with (app/'Info.plist').open('rb') as f:info=plistlib.load(f)
 except (OSError,plistlib.InvalidFileException):return {'checked':True,'passed':False,'errors':[{'code':'invalid_app_info'}]}
 metadata=[app/p for p in ['Data/Managed/Metadata/global-metadata.dat',
  'Frameworks/UnityFramework.framework/Data/Managed/Metadata/global-metadata.dat'] if (app/p).is_file()]
 native=app/'Frameworks/UnityFramework.framework/UnityFramework'
 if not metadata:errors.append({'code':'missing_il2cpp_metadata'})
 if not native.is_file():errors.append({'code':'missing_unity_framework'})
 binaries=metadata+([native] if native.is_file() else [])
 for binary in binaries:
  rel=binary.relative_to(app).as_posix()
  if binary.is_symlink():errors.append({'code':'binary_symlink_requires_review','path':rel});continue
  with binary.open('rb') as f:
   magic=f.read(4)
   valid=(magic==bytes.fromhex('af1bb1fa')) if binary.name=='global-metadata.dat' else magic in MACHO_MAGICS
   if not valid:errors.append({'code':'unsupported_binary_format','path':rel});continue
   with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as data:
    hits=[m for m in markers if data.find(m.encode())>=0]
   if hits:findings.append({'path':rel,'markers':hits})
 if findings:errors.append({'code':'known_qa_markers_in_app','findings':findings})
 return {'checked':True,'passed':not errors,'bundle_id':info.get('CFBundleIdentifier'),
         'scanned_files':[p.relative_to(app).as_posix() for p in binaries],'errors':errors}

def check_artifacts(project=None,archive=None,app=None,excludes=(),markers=()):
 if not archive and not app:raise ValueError('Provide an archive and/or app')
 markers=tuple(dict.fromkeys(DEFAULT_MARKERS+tuple(markers)))
 if any(not isinstance(m,str) or len(m)<3 for m in markers):raise ValueError('Markers must be explicit nonempty identifiers')
 result={'archive':{'checked':False},'app':{'checked':False},'installed_device_verified':False,
         'cold_start_verified':False,'sdk_delivery_verified':False}
 if archive:result['archive']=archive_check(Path(project) if project else None,Path(archive),set(excludes),markers)
 if app:result['app']=app_check(Path(app),markers)
 result['passed']=all(result[k].get('passed') for k in ['archive','app'] if result[k]['checked'])
 return result

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--project',type=Path)
 parser.add_argument('--archive',type=Path)
 parser.add_argument('--app',type=Path)
 parser.add_argument('--exclude',action='append',default=[],help='Exact source-relative file intentionally omitted from ZIP; no wildcard')
 parser.add_argument('--forbid-marker',action='append',default=[],help='Additional known QA class/symbol; defaults remain enabled')
 args=parser.parse_args()
 if args.archive and not args.project:parser.error('--archive requires --project')
 if not args.archive and not args.app:parser.error('Provide --archive and/or --app')
 try:result=check_artifacts(args.project,args.archive,args.app,args.exclude,args.forbid_marker)
 except (OSError,ValueError,zipfile.BadZipFile) as error:
  print(json.dumps({'passed':False,'input_error':type(error).__name__}));return 2
 print(json.dumps(result,ensure_ascii=False,indent=2));return 0 if result['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
