<#
.SYNOPSIS
    One-time setup of SharePoint storage for the BankBook widget function.

.DESCRIPTION
    1. Creates a Microsoft 365 group "BankBook" -> SharePoint team site /sites/BankBook
    2. Creates the lists "AppState" and "PaidPayments" (same schema as sharepoint.js)
    3. Registers an Entra app with Graph "Sites.Selected" (admin-consented) and
       grants it WRITE on this one site only — it cannot touch any other site.
    4. Creates a client secret and prints the SP_* values for the Catalyst function.

    Safe to re-run: existing group / lists / app are reused.
    Run as a Global Admin (or a user who can consent to app permissions).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\create-sharepoint-site.ps1
#>
param(
    [string]$SiteName = "BankBook",
    [string]$AppName  = "BankBook Widget - SharePoint Storage",
    [int]$SecretYears = 2
)

$ErrorActionPreference = "Stop"

# ---- Module + sign-in --------------------------------------------------------
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    Write-Host "Installing Microsoft.Graph.Authentication module (CurrentUser)..." -ForegroundColor Cyan
    Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
}
Import-Module Microsoft.Graph.Authentication

Connect-MgGraph -NoWelcome -Scopes @(
    "User.Read",
    "Group.ReadWrite.All",
    "Sites.FullControl.All",
    "Application.ReadWrite.All",
    "AppRoleAssignment.ReadWrite.All"
)

$G = "https://graph.microsoft.com/v1.0"

function Invoke-Graph([string]$Method, [string]$Uri, $Body = $null) {
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 10
        return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body $json -ContentType "application/json"
    }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}

$ctx = Get-MgContext
$me  = Invoke-Graph GET "$G/me?`$select=id,userPrincipalName"
Write-Host "Signed in as $($me.userPrincipalName) (tenant $($ctx.TenantId))" -ForegroundColor Green

# ---- 1. Group + team site ---------------------------------------------------
$existing = Invoke-Graph GET "$G/groups?`$filter=mailNickname eq '$SiteName'&`$select=id,displayName"
if ($existing.value.Count -gt 0) {
    $group = $existing.value[0]
    Write-Host "Group '$SiteName' already exists ($($group.id))." -ForegroundColor Yellow
} else {
    Write-Host "Creating Microsoft 365 group '$SiteName'..." -ForegroundColor Cyan
    $group = Invoke-Graph POST "$G/groups" @{
        displayName          = $SiteName
        description          = "Storage for the BankBook (IndusInd) Zoho Books widget"
        mailNickname         = $SiteName
        mailEnabled          = $true
        securityEnabled      = $false
        groupTypes           = @("Unified")
        visibility           = "Private"
        "owners@odata.bind"  = @("$G/users/$($me.id)")
    }
}

Write-Host "Waiting for the SharePoint site to be provisioned (can take a few minutes)..." -ForegroundColor Cyan
$site = $null
for ($i = 0; $i -lt 40 -and -not $site; $i++) {
    try   { $site = Invoke-Graph GET "$G/groups/$($group.id)/sites/root?`$select=id,webUrl" }
    catch { Start-Sleep -Seconds 15 }
}
if (-not $site) { throw "Site was not ready after 10 minutes. Re-run this script later; it will continue from here." }

$siteUri  = [Uri]$site.webUrl
$hostname = $siteUri.Host
$sitePath = $siteUri.AbsolutePath.TrimEnd("/")
Write-Host "Site ready: $($site.webUrl)" -ForegroundColor Green

# ---- 2. Lists (schema must match sharepoint.js -> LISTS) ---------------------
$lists = @(
    @{ displayName = "AppState"; list = @{ template = "genericList" }; columns = @(
        @{ name = "StateValue"; text = @{ allowMultipleLines = $true; textType = "plain"; linesForEditing = 6 } }
    ) },
    @{ displayName = "PaidPayments"; list = @{ template = "genericList" }; columns = @(
        @{ name = "Source";        text = @{}; indexed = $true },
        @{ name = "PaymentId";     text = @{} },
        @{ name = "PaymentNumber"; text = @{} },
        @{ name = "VendorName";    text = @{} },
        @{ name = "Amount";        text = @{} },
        @{ name = "UTR";           text = @{} },
        @{ name = "PaidAt";        text = @{} },
        @{ name = "ExpireAt";      number = @{} }
    ) }
)

foreach ($def in $lists) {
    $found = Invoke-Graph GET "$G/sites/$($site.id)/lists?`$filter=displayName eq '$($def.displayName)'&`$select=id"
    if ($found.value.Count -gt 0) {
        Write-Host "List '$($def.displayName)' already exists." -ForegroundColor Yellow
    } else {
        Invoke-Graph POST "$G/sites/$($site.id)/lists" $def | Out-Null
        Write-Host "Created list '$($def.displayName)'." -ForegroundColor Green
    }
}

# ---- 3. App registration (Sites.Selected) -----------------------------------
$graphSp  = (Invoke-Graph GET "$G/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'&`$select=id,appRoles").value[0]
$roleId   = ($graphSp.appRoles | Where-Object { $_.value -eq "Sites.Selected" }).id

$appFound = Invoke-Graph GET "$G/applications?`$filter=displayName eq '$AppName'&`$select=id,appId"
if ($appFound.value.Count -gt 0) {
    $app = $appFound.value[0]
    Write-Host "App '$AppName' already exists ($($app.appId))." -ForegroundColor Yellow
} else {
    $app = Invoke-Graph POST "$G/applications" @{
        displayName            = $AppName
        signInAudience         = "AzureADMyOrg"
        requiredResourceAccess = @(@{
            resourceAppId  = "00000003-0000-0000-c000-000000000000"
            resourceAccess = @(@{ id = $roleId; type = "Role" })
        })
    }
    Write-Host "Registered app '$AppName' ($($app.appId))." -ForegroundColor Green
}

$spFound = Invoke-Graph GET "$G/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id"
if ($spFound.value.Count -gt 0) { $sp = $spFound.value[0] }
else { $sp = Invoke-Graph POST "$G/servicePrincipals" @{ appId = $app.appId } }

# Admin consent for Sites.Selected
$assigned = Invoke-Graph GET "$G/servicePrincipals/$($sp.id)/appRoleAssignments"
if (-not ($assigned.value | Where-Object { $_.appRoleId -eq $roleId })) {
    Invoke-Graph POST "$G/servicePrincipals/$($graphSp.id)/appRoleAssignedTo" @{
        principalId = $sp.id
        resourceId  = $graphSp.id
        appRoleId   = $roleId
    } | Out-Null
    Write-Host "Granted admin consent: Graph Sites.Selected." -ForegroundColor Green
}

# Write access to THIS site only
$perms = Invoke-Graph GET "$G/sites/$($site.id)/permissions"
$hasPerm = $perms.value | Where-Object { $_.grantedToIdentitiesV2.application.id -eq $app.appId -or $_.grantedToIdentities.application.id -eq $app.appId }
if (-not $hasPerm) {
    Invoke-Graph POST "$G/sites/$($site.id)/permissions" @{
        roles               = @("write")
        grantedToIdentities = @(@{ application = @{ id = $app.appId; displayName = $AppName } })
    } | Out-Null
    Write-Host "Granted app WRITE on $($site.webUrl)." -ForegroundColor Green
}

# ---- 4. Client secret --------------------------------------------------------
$secret = Invoke-Graph POST "$G/applications/$($app.id)/addPassword" @{
    passwordCredential = @{
        displayName = "Catalyst function ($(Get-Date -Format yyyy-MM-dd))"
        endDateTime = (Get-Date).ToUniversalTime().AddYears($SecretYears).ToString("o")
    }
}

Write-Host ""
Write-Host "==================== Catalyst env variables ====================" -ForegroundColor Cyan
Write-Host "SP_TENANT_ID     = $($ctx.TenantId)"
Write-Host "SP_CLIENT_ID     = $($app.appId)"
Write-Host "SP_CLIENT_SECRET = $($secret.secretText)"
Write-Host "SP_SITE_HOSTNAME = $hostname"
Write-Host "SP_SITE_PATH     = $sitePath"
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Secret expires $($secret.endDateTime). It is shown only once - store it now." -ForegroundColor Yellow

Disconnect-MgGraph | Out-Null
