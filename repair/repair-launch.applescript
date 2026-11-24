-- AAB助手启动修复：使用本工具所在文件夹和当前用户目录定位应用。
on run
    set helperPath to POSIX path of (path to me)
    set siblingDir to do shell script "/usr/bin/dirname " & quoted form of text 1 thru -2 of helperPath
    set homePath to POSIX path of (path to home folder)
    set candidates to {siblingDir & "/AAB助手.app", "/Applications/AAB助手.app", homePath & "Applications/AAB助手.app"}
    set targetApp to ""
    repeat with candidate in candidates
        try
            do shell script "/bin/test -d " & quoted form of (contents of candidate)
            set targetApp to contents of candidate
            exit repeat
        end try
    end repeat
    if targetApp is "" then
        try
            set chosenApp to choose application with prompt "请选择要修复的 AAB助手.app" as alias
            set targetApp to POSIX path of chosenApp
            if targetApp ends with "/" then set targetApp to text 1 thru -2 of targetApp
        on error number -128
            return
        end try
    end if
    set resPath to POSIX path of (path to resource "partner-agent-fix.sh")
    set cmd to "/bin/sh " & quoted form of resPath & " " & quoted form of targetApp
    try
        set outText to do shell script cmd
        set exitCode to 0
    on error errMsg number errNum
        set outText to errMsg
        set exitCode to errNum
    end try
    if exitCode is 0 or exitCode is 10 then
        try
            do shell script "/usr/bin/open " & quoted form of targetApp
            display notification "正在打开 AAB助手。" with title "启动修复完成"
        on error errMsg
            display dialog "隔离标记已处理，但应用未能打开：" & return & errMsg with title "AAB助手启动修复" buttons {"好"} default button "好" with icon caution
        end try
    else
        display dialog outText & return & return & "请确认选择了完整的 AAB助手.app，并检查目录写入权限。" with title "AAB助手启动修复" buttons {"好"} default button "好" with icon caution
    end if
end run
