import gzip
import io
import re
import os
import sys
import datetime
import requests

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Cyrillic to English transliteration map
CYRILLIC_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
    'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
    'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
    'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch',
    'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya'
}

TRANSLATIONS = {
    r'\bФильм\b': 'Movie',
    r'\bфильм\b': 'movie',
    r'\bСериал\b': 'TV Series',
    r'\bсериал\b': 'tv series',
    r'\bНовости\b': 'News',
    r'\bновости\b': 'news',
    r'\bСпорт\b': 'Sport',
    r'\bспорт\b': 'sport',
    r'\bФутбол\b': 'Football',
    r'\bфутбол\b': 'football',
    r'\bХоккей\b': 'Hockey',
    r'\bхоккей\b': 'hockey',
    r'\bПрямой эфир\b': 'Live',
    r'\bпрямой эфир\b': 'live',
    r'\bЧемпионат\b': 'Championship',
    r'\bчемпионат\b': 'championship',
    r'\bМатч\b': 'Match',
    r'\bматч\b': 'match',
    r'\bОбзор\b': 'Highlights',
    r'\bобзор\b': 'highlights',
    r'\bПремьера\b': 'Premiere',
    r'\bпремьера\b': 'premiere'
}

def transliterate_to_english(text):
    if not text:
        return ""
    for pattern, repl in TRANSLATIONS.items():
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    res = [CYRILLIC_MAP.get(ch, ch) for ch in text]
    return "".join(res)

def convert_time_to_myanmar(time_str):
    # XMLTV time format: YYYYMMDDHHMMSS +0000 or YYYYMMDDHHMMSS
    if not time_str or len(time_str) < 14:
        return time_str
    try:
        dt_part = time_str[:14]
        dt = datetime.datetime.strptime(dt_part, "%Y%m%d%H%M%S")
        
        offset_hours = 0
        offset_mins = 0
        if len(time_str) >= 20 and time_str[14] in [' ', '+', '-']:
            sign = 1 if time_str[15] == '+' else -1
            offset_hours = sign * int(time_str[16:18])
            offset_mins = sign * int(time_str[18:20])
            src_offset = datetime.timedelta(hours=offset_hours, minutes=offset_mins)
            utc_dt = dt - src_offset
        else:
            utc_dt = dt
            
        mmt_dt = utc_dt + datetime.timedelta(hours=6, minutes=30)
        return mmt_dt.strftime("%Y%m%d%H%M%S") + " +0630"
    except Exception:
        return time_str

def clean_name(s):
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r'-\s*vpn', '', s)
    s = re.sub(r'\b(hd|fhd|uhd|4k|sd|tv|plus)\b', '', s)
    s = re.sub(r'\[.*?\]|\(.*?\)', '', s)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s.strip()

def build_myanmar_epg(playlist_path="final_playlist.m3u", output_epg_path="epg.xml.gz"):
    print("=== STARTING ULTRA-FAST STREAMING EPG GENERATOR ===", flush=True)
    print("Timezone: Myanmar Standard Time (+06:30) | Language: English Transliterated", flush=True)
    
    target_channels = {}
    channel_display_names = {}
    
    if not os.path.exists(playlist_path):
        print(f"Error: {playlist_path} not found!", flush=True)
        return False
        
    with open(playlist_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("#EXTINF:"):
                tid_m = re.search(r'tvg-id="([^"]+)"', line)
                name_m = re.search(r',(.+)$', line)
                name = name_m.group(1).strip() if name_m else ""
                tid = tid_m.group(1) if tid_m else name
                
                if tid:
                    channel_display_names[tid] = name
                    target_channels[tid.lower()] = tid
                    target_channels[name.lower()] = tid
                    target_channels[clean_name(name)] = tid
                    
    print(f"Loaded {len(channel_display_names)} target channels from {playlist_path}", flush=True)
    
    epg_sources = [
        ("Malaysia (Astro)", "https://epg.pw/xmltv/epg_MY.xml.gz"),
        ("Singapore (Hub/beIN)", "https://epg.pw/xmltv/epg_SG.xml.gz"),
        ("United Kingdom (Sky/TNT)", "https://epg.pw/xmltv/epg_GB.xml.gz"),
    ]
    
    matched_channels = set()
    programmes_out = []
    
    for country, url in epg_sources:
        print(f"Fetching {country}...", flush=True)
        try:
            r = requests.get(url, timeout=25)
            if r.status_code != 200:
                print(f"  Warning: Status {r.status_code}", flush=True)
                continue
                
            src_channel_map = {}
            current_prog = None
            
            with gzip.GzipFile(fileobj=io.BytesIO(r.content)) as gz:
                for line in gz:
                    l_str = line.decode('utf-8', errors='ignore')
                    
                    # Channel block
                    if '<channel id=' in l_str:
                        m_cid = re.search(r'<channel id="([^"]+)"', l_str)
                        if m_cid:
                            last_cid = m_cid.group(1)
                    elif '<display-name' in l_str and 'last_cid' in locals():
                        m_dname = re.search(r'<display-name[^>]*>([^<]+)</display-name>', l_str)
                        if m_dname:
                            src_name = m_dname.group(1).strip()
                            target_id = None
                            if last_cid.lower() in target_channels:
                                target_id = target_channels[last_cid.lower()]
                            elif src_name.lower() in target_channels:
                                target_id = target_channels[src_name.lower()]
                            elif clean_name(src_name) in target_channels:
                                target_id = target_channels[clean_name(src_name)]
                                
                            if target_id:
                                src_channel_map[last_cid] = target_id
                                matched_channels.add(target_id)
                                
                    # Programme block
                    elif '<programme ' in l_str:
                        start_m = re.search(r'start="([^"]+)"', l_str)
                        stop_m = re.search(r'stop="([^"]+)"', l_str)
                        ch_m = re.search(r'channel="([^"]+)"', l_str)
                        if start_m and stop_m and ch_m:
                            ch_id = ch_m.group(1)
                            if ch_id in src_channel_map:
                                current_prog = {
                                    'channel': src_channel_map[ch_id],
                                    'start': convert_time_to_myanmar(start_m.group(1)),
                                    'stop': convert_time_to_myanmar(stop_m.group(1)),
                                    'title': 'TV Show',
                                    'desc': ''
                                }
                            else:
                                current_prog = None
                                
                    elif current_prog is not None:
                        if '<title' in l_str:
                            m_t = re.search(r'<title[^>]*>([^<]+)</title>', l_str)
                            if m_t:
                                current_prog['title'] = transliterate_to_english(m_t.group(1).strip())
                        elif '<desc' in l_str:
                            m_d = re.search(r'<desc[^>]*>([^<]+)</desc>', l_str)
                            if m_d:
                                current_prog['desc'] = transliterate_to_english(m_d.group(1).strip())
                        elif '</programme>' in l_str:
                            p_start = current_prog['start']
                            p_stop = current_prog['stop']
                            p_ch = current_prog['channel']
                            p_title = current_prog['title']
                            p_desc = current_prog['desc']
                            p_xml = f'  <programme start="{p_start}" stop="{p_stop}" channel="{p_ch}">\n    <title lang="en">{p_title}</title>'
                            if p_desc:
                                p_xml += f'\n    <desc lang="en">{p_desc}</desc>'
                            p_xml += '\n  </programme>'
                            programmes_out.append(p_xml)
                            current_prog = None
                            
            print(f"  -> Matched {len(src_channel_map)} channels in {country}", flush=True)
            
        except Exception as e:
            print(f"  -> Error: {e}", flush=True)
            
    print(f"\nTotal matched unique channels with EPG: {len(matched_channels)}", flush=True)
    print(f"Total programme schedules: {len(programmes_out)}", flush=True)
    
    print(f"Writing compressed {output_epg_path}...", flush=True)
    xml_header = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Myanmar-OTT-EPG" source-info-name="MMT +0630 EPG">\n'
    channel_blocks = []
    for tid in matched_channels:
        dname = channel_display_names.get(tid, tid)
        dname_en = transliterate_to_english(dname)
        channel_blocks.append(f'  <channel id="{tid}">\n    <display-name lang="en">{dname_en}</display-name>\n  </channel>')
        
    full_xml = xml_header + '\n'.join(channel_blocks) + '\n' + '\n'.join(programmes_out) + '\n</tv>\n'
    
    with gzip.open(output_epg_path, "wt", encoding="utf-8") as f_out:
        f_out.write(full_xml)
        
    size_kb = os.path.getsize(output_epg_path) / 1024
    print(f"SUCCESS! Created {output_epg_path} ({size_kb:.1f} KB).", flush=True)
    return True

if __name__ == "__main__":
    m3u_file = sys.argv[1] if len(sys.argv) > 1 else "final_playlist.m3u"
    epg_file = sys.argv[2] if len(sys.argv) > 2 else "epg.xml.gz"
    build_myanmar_epg(m3u_file, epg_file)
