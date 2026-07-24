# GitGuardian shield for Azure DevOps

Find exposed credentials in your commits using [GitGuardian shield](https://github.com/GitGuardian/ggshield).
breaks
The **GitGuardian shield** (ggshield) is a CLI application that runs in your local environment or in a CI environment to help you detect more than 600 types of secrets.
**GitGuardian shield** uses our [public API](https://api.gitguardian.com/doc) through [py-gitguardian](https://github.com/GitGuardian/py-gitguardian) to scan your files and detect potential secrets or issues in your code. **The `/v1/scan` endpoint of the [public API](https://api.gitguardian.com/doc) is stateless. We will not store any files you are sending or any secrets we have detected**.

## Requirements

- A GitGuardian account. [**Sign up now**](https://dashboard.gitguardian.com/api/v1/auth/user/github_login/authorize?utm_source=github&utm_medium=gg_shield&utm_campaign=shield1) if you haven't before!
- A GitGuardian API Key. You can create your API Key [**here**](https://dashboard.gitguardian.com/api/v1/auth/user/github_login/authorize?utm_source=github&utm_medium=gg_shield&utm_campaign=shield1). The only required scope is `scan`.

## Usage

### Add the `ggshield` Task

Add a new task to your Azure DevOps pipeline using the `ggshield` task.

```yaml
steps:
  - task: ggshield@0
    inputs:
      gitguardianConnection: gitguardian-api
```

### Set Up a Service Connection

1. Configure a new service connection in your Azure DevOps project settings
2. Set the URL of your GitGuardian instance (default `https://dashboard.gitguardian.com`) as a server URL
3. Set your GitGuardian service account token as a password
4. Set the service connection name to `gitguardian-api``
5. Grant access permission to all pipelines

![Generic service connection configured for ggshield](images/service-connection-generic.png)

## Examples of GitGuardian scanning

![Scan output example](images/pipeline-scan-result.png)

This a sample scan result from **GitGuardian shield**.

If the secret detected has been revoked and you do not wish to rewrite git history, you can use a value of the policy break (for example: the value of `|_password_|`) or the ignore SHA displayed in your `.gitguardian.yaml` under `matches-ignore`.

An example configuration file is available [here](https://github.com/GitGuardian/ggshield/blob/main/.gitguardian.example.yml).

### Exit Status

The extension task

- fails if secrets were found in the scanned commits
- succeeds if no secrets were found
- succeeds with issues if `ggshield` fails to connect to the GitGuardian instance
- fails if an unexpected error occurs in the `ggshield` pipeline task
